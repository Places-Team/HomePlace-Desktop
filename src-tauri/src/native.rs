use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

const MAX_SHARED_FILES: usize = 20;
const MAX_SHARED_TEXT_CHARS: usize = 8_000;
const MAX_SHARED_FILE_BYTES: u64 = 500 * 1024 * 1024;
static PENDING_SHARE: LazyLock<Mutex<Option<PendingShare>>> = LazyLock::new(|| Mutex::new(None));

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingShare {
    files: Vec<String>,
    text: Option<String>,
    error: Option<String>,
}

#[cfg(target_os = "macos")]
fn bridge_path() -> Option<PathBuf> {
    let bundled = std::env::current_exe().ok().and_then(|path| {
        path.parent()
            .map(|parent| parent.join("HomePlaceNativeBridge"))
    });
    let development =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("macos/build/HomePlaceNativeBridge");
    bundled
        .filter(|path| path.is_file())
        .or_else(|| development.is_file().then_some(development))
}

#[cfg(target_os = "macos")]
pub fn start_drag_monitor<R: Runtime>(app: AppHandle<R>) {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    let Some(bridge) = bridge_path() else {
        return;
    };
    std::thread::spawn(move || {
        let Ok(mut child) = Command::new(bridge)
            .arg("monitor-drag")
            .arg(std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        else {
            return;
        };
        let Some(stdout) = child.stdout.take() else {
            return;
        };
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            match line.as_str() {
                "drag-start" => crate::tray::show_quick_share_for_drag(&app),
                "drag-end" => crate::tray::finish_quick_share_drag(&app),
                _ => {}
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn start_drag_monitor<R: Runtime>(_app: AppHandle<R>) {}

#[tauri::command]
pub async fn authenticate_sensitive_action(reason: String) -> Result<(), String> {
    if reason.trim().is_empty() || reason.chars().count() > 160 {
        return Err("The authentication reason is invalid.".into());
    }

    #[cfg(target_os = "macos")]
    {
        let bridge = bridge_path()
            .ok_or_else(|| "Touch ID support is unavailable in this build.".to_string())?;
        let result = tauri::async_runtime::spawn_blocking(move || {
            std::process::Command::new(bridge)
                .arg("authenticate")
                .arg(reason)
                .output()
        })
        .await
        .map_err(|_| "Touch ID authentication was interrupted.".to_string())?
        .map_err(|_| "Touch ID authentication could not be started.".to_string())?;
        if result.status.success() && String::from_utf8_lossy(&result.stdout).trim() == "accepted" {
            Ok(())
        } else {
            Err("Touch ID authentication was cancelled or denied.".into())
        }
    }

    #[cfg(not(target_os = "macos"))]
    Err("Biometric confirmation is not available on this platform yet.".into())
}

#[tauri::command]
pub fn take_pending_share() -> Option<PendingShare> {
    PENDING_SHARE.lock().ok()?.take()
}

fn pending_share_from_arguments(arguments: &[String]) -> Option<PendingShare> {
    let mut files = Vec::new();
    let mut text = None;
    let mut explorer_invocation = false;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--homeplace-share" => {
                explorer_invocation = true;
                for value in arguments.iter().skip(index + 1) {
                    if files.len() >= MAX_SHARED_FILES {
                        break;
                    }
                    let path = Path::new(value);
                    if is_safe_shared_file(path) {
                        files.push(path.to_string_lossy().into_owned());
                    }
                }
                break;
            }
            "--homeplace-share-file" if files.len() < MAX_SHARED_FILES => {
                if let Some(value) = arguments.get(index + 1) {
                    let path = Path::new(value);
                    if is_safe_shared_file(path) {
                        files.push(path.to_string_lossy().into_owned());
                    }
                    index += 1;
                }
            }
            "--homeplace-share-text" if text.is_none() => {
                if let Some(value) = arguments.get(index + 1) {
                    let value = value.trim();
                    if !value.is_empty()
                        && value.chars().count() <= MAX_SHARED_TEXT_CHARS
                        && !value.chars().any(|character| {
                            character.is_control() && character != '\n' && character != '\t'
                        })
                    {
                        text = Some(value.to_string());
                    }
                    index += 1;
                }
            }
            _ => {}
        }
        index += 1;
    }

    if files.is_empty() && text.is_none() && !explorer_invocation {
        return None;
    }
    let error = (explorer_invocation && files.is_empty()).then(|| {
        "Windows did not provide a readable file. Try Share with HomePlace again.".to_string()
    });
    Some(PendingShare { files, text, error })
}

fn stage_pending_share(stored: &mut Option<PendingShare>, pending: PendingShare) {
    if let Some(existing) = stored.as_mut()
        && existing.text.is_none()
        && pending.text.is_none()
    {
        for file in pending.files {
            if !existing.files.contains(&file) {
                if existing.files.len() == MAX_SHARED_FILES {
                    existing.error = Some("Choose up to 20 files per transfer.".into());
                    break;
                }
                existing.files.push(file);
            }
        }
        if pending.error.is_some() {
            existing.error = pending.error;
        }
    } else {
        *stored = Some(pending);
    }
}

pub fn dispatch_share_arguments<R: Runtime>(app: &AppHandle<R>, arguments: &[String]) -> bool {
    let Some(pending) = pending_share_from_arguments(arguments) else {
        return false;
    };
    if let Ok(mut stored) = PENDING_SHARE.lock() {
        stage_pending_share(&mut stored, pending);
    } else {
        return false;
    }
    let _ = app.emit("quick-share-staged", ());
    crate::tray::show_quick_share_from_extension(app);
    true
}

fn is_safe_shared_file(path: &Path) -> bool {
    path.is_absolute()
        && path.is_file()
        && path
            .metadata()
            .is_ok_and(|metadata| metadata.len() <= MAX_SHARED_FILE_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_and_missing_shared_files() {
        assert!(!is_safe_shared_file(Path::new("relative.txt")));
        assert!(!is_safe_shared_file(Path::new(
            "/missing/homeplace-share.txt"
        )));
    }

    #[test]
    fn explorer_share_marker_collects_multiple_existing_files() {
        let first =
            std::env::temp_dir().join(format!("homeplace-share-{}-1.txt", std::process::id()));
        let second =
            std::env::temp_dir().join(format!("homeplace-share-{}-2.txt", std::process::id()));
        std::fs::write(&first, b"one").unwrap();
        std::fs::write(&second, b"two").unwrap();
        let arguments = vec![
            "homeplace-desktop.exe".to_string(),
            "--homeplace-share".to_string(),
            first.to_string_lossy().into_owned(),
            second.to_string_lossy().into_owned(),
        ];

        let pending = pending_share_from_arguments(&arguments).unwrap();
        assert_eq!(
            pending.files,
            vec![
                first.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned()
            ]
        );
        assert!(pending.text.is_none());
        assert!(pending.error.is_none());

        let _ = std::fs::remove_file(first);
        let _ = std::fs::remove_file(second);
    }

    #[test]
    fn explorer_share_marker_reports_missing_shell_input() {
        let pending = pending_share_from_arguments(&[
            "homeplace-desktop.exe".to_string(),
            "--homeplace-share".to_string(),
            "%1".to_string(),
        ])
        .unwrap();
        assert!(pending.files.is_empty());
        assert!(pending.error.is_some());
    }

    #[test]
    fn separate_shell_invocations_preserve_files_and_report_overflow() {
        let mut stored = None;
        for index in 0..=MAX_SHARED_FILES {
            stage_pending_share(
                &mut stored,
                PendingShare {
                    files: vec![format!("file-{index}.txt")],
                    text: None,
                    error: None,
                },
            );
        }
        let pending = stored.as_ref().unwrap();
        assert_eq!(pending.files.len(), MAX_SHARED_FILES);
        assert_eq!(pending.files[0], "file-0.txt");
        assert!(pending.error.is_some());
        stage_pending_share(
            &mut stored,
            PendingShare {
                files: vec!["file-0.txt".into()],
                text: None,
                error: None,
            },
        );
        assert_eq!(stored.unwrap().files.len(), MAX_SHARED_FILES);
    }
}
