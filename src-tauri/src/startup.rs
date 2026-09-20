use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatus {
    enabled: bool,
}

#[tauri::command]
pub fn startup_status<R: Runtime>(app: AppHandle<R>) -> Result<StartupStatus, String> {
    let enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|_| "Could not read the system startup setting.".to_string())?;
    Ok(StartupStatus { enabled })
}

#[tauri::command]
pub fn set_startup_enabled<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<StartupStatus, String> {
    let manager = app.autolaunch();
    if enabled {
        manager
            .enable()
            .map_err(|_| "Could not add HomePlace to system startup.".to_string())?;
    } else {
        manager
            .disable()
            .map_err(|_| "Could not remove HomePlace from system startup.".to_string())?;
    }

    let actual = manager
        .is_enabled()
        .map_err(|_| "Could not verify the system startup setting.".to_string())?;
    if actual != enabled {
        return Err("The operating system did not apply the startup setting.".into());
    }
    Ok(StartupStatus { enabled: actual })
}

pub fn starts_hidden() -> bool {
    has_hidden_argument(std::env::args_os())
}

fn has_hidden_argument<I, S>(arguments: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    arguments
        .into_iter()
        .any(|argument| argument.as_ref() == "--hidden")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_only_the_exact_hidden_argument() {
        assert!(has_hidden_argument(["homeplace", "--hidden"]));
        assert!(!has_hidden_argument(["homeplace", "hidden"]));
        assert!(!has_hidden_argument(["homeplace", "--hidden=true"]));
    }
}
