use super::PlatformInfo;
use tauri::Manager;
use windows::Win32::Graphics::Dwm::{
    DWMSBT_MAINWINDOW, DWMSBT_TRANSIENTWINDOW, DWMWA_SYSTEMBACKDROP_TYPE,
    DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    DwmSetWindowAttribute,
};
use winreg::{RegKey, enums::HKEY_CURRENT_USER};

const SHARE_MENU_KEY: &str = r"Software\Classes\*\shell\HomePlaceQuickShare";

fn set_dwm_attribute<T>(
    window: &tauri::WebviewWindow,
    attribute: windows::Win32::Graphics::Dwm::DWMWINDOWATTRIBUTE,
    value: &T,
) {
    let Ok(hwnd) = window.hwnd() else { return };
    // DWM attributes are best-effort: older Windows versions simply reject
    // the Windows 11-only backdrop attributes.
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            attribute,
            std::ptr::from_ref(value).cast(),
            std::mem::size_of::<T>() as u32,
        )
    };
}

fn apply_windows_11_style(window: &tauri::WebviewWindow, transient: bool) {
    set_dwm_attribute(window, DWMWA_USE_IMMERSIVE_DARK_MODE, &1_i32);
    set_dwm_attribute(window, DWMWA_WINDOW_CORNER_PREFERENCE, &DWMWCP_ROUND);
    let backdrop = if transient {
        DWMSBT_TRANSIENTWINDOW
    } else {
        DWMSBT_MAINWINDOW
    };
    set_dwm_attribute(window, DWMWA_SYSTEMBACKDROP_TYPE, &backdrop);
}

fn register_explorer_share_action() -> std::io::Result<()> {
    let executable = std::env::current_exe()?;
    let executable = executable.to_string_lossy();
    let registry = RegKey::predef(HKEY_CURRENT_USER);
    let (menu, _) = registry.create_subkey(SHARE_MENU_KEY)?;
    menu.set_value("MUIVerb", &"Share with HomePlace")?;
    menu.set_value("Icon", &executable.as_ref())?;
    menu.set_value("MultiSelectModel", &"Player")?;
    let (command, _) = menu.create_subkey("command")?;
    command.set_value("", &format!(r#""{executable}" --homeplace-share "%1""#))?;
    Ok(())
}

pub fn configure(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_decorations(false)?;
        window.set_shadow(true)?;
        apply_windows_11_style(&window, false);
    }
    if let Some(window) = app.get_webview_window("quick-share") {
        apply_windows_11_style(&window, true);
    }
    // Per-user registration needs no elevation and gives Explorer a native
    // multi-file action (under "Show more options" on Windows 11).
    let _ = register_explorer_share_action();
    Ok(())
}

pub fn info() -> PlatformInfo {
    PlatformInfo {
        platform: "windows",
        label: "Windows",
        secure_storage: "Credential Manager",
        tray: true,
        device_name: super::device_name("Windows PC"),
        platform_version: super::platform_version(),
    }
}
