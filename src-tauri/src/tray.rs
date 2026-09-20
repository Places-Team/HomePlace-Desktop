use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    App, AppHandle, Manager, Runtime,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_notification::NotificationExt;

pub const TRAY_ID: &str = "homeplace";
static BACKGROUND_NOTICE_SHOWN: AtomicBool = AtomicBool::new(false);

#[derive(Debug, PartialEq, Eq)]
enum TrayCommand {
    Show,
    Quit,
}

pub fn install(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open HomePlace", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit HomePlace", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("HomePlace Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match tray_command(event.id().as_ref()) {
            Some(TrayCommand::Show) => show_main_window(app),
            Some(TrayCommand::Quit) => app.exit(0),
            None => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn set_connection_state<R: Runtime>(app: &AppHandle<R>, state: ConnectionState) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let tooltip = match state {
        ConnectionState::Connected => "HomePlace Desktop — Connected",
        ConnectionState::Interrupted => "HomePlace Desktop — Connection interrupted",
        ConnectionState::NotConfigured => "HomePlace Desktop — Not connected",
    };
    let _ = tray.set_tooltip(Some(tooltip));
}

pub fn notify_window_hidden<R: Runtime>(app: &AppHandle<R>) {
    if BACKGROUND_NOTICE_SHOWN.swap(true, Ordering::Relaxed) {
        return;
    }
    let _ = app
        .notification()
        .builder()
        .title("HomePlace Desktop is still running")
        .body("Link remains active in the system tray so devices and notifications stay connected.")
        .show();
}

pub enum ConnectionState {
    Connected,
    Interrupted,
    NotConfigured,
}

fn tray_command(id: &str) -> Option<TrayCommand> {
    match id {
        "open" => Some(TrayCommand::Show),
        "quit" => Some(TrayCommand::Quit),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_only_known_tray_commands() {
        assert_eq!(tray_command("open"), Some(TrayCommand::Show));
        assert_eq!(tray_command("quit"), Some(TrayCommand::Quit));
        assert_eq!(tray_command("notification.deliver"), None);
    }
}
