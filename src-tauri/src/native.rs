use std::path::{Path, PathBuf};
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

pub fn dispatch_share_arguments<R: Runtime>(app: &AppHandle<R>, arguments: &[String]) -> bool {
    let mut files = Vec::new();
    let mut text = None;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
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

    if files.is_empty() && text.is_none() {
        return false;
    }
    let pending = PendingShare { files, text };
    if let Ok(mut stored) = PENDING_SHARE.lock() {
        *stored = Some(pending);
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
}
