use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    App, AppHandle, Emitter, Manager, Runtime,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_notification::NotificationExt;

pub const TRAY_ID: &str = "homeplace";
const PROFILE_CHANGED_EVENT: &str = "link-profile-changed";
static BACKGROUND_NOTICE_SHOWN: AtomicBool = AtomicBool::new(false);

#[derive(Debug, PartialEq, Eq)]
enum TrayCommand {
    Show,
    Reconnect,
    Quit,
}

pub enum ConnectionState {
    Connected,
    Interrupted,
    NotConfigured,
}

pub fn install(app: &App) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("HomePlace Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(server_id) = profile_server_id(id) {
                match crate::link::client::activate_stored_profile(server_id) {
                    Ok(_) => {
                        refresh_menu(app);
                        if let Some(service) =
                            app.try_state::<crate::link::client::HeartbeatService>()
                        {
                            service.wake();
                        }
                        let _ = app.emit(PROFILE_CHANGED_EVENT, server_id);
                    }
                    Err(_) => {
                        let _ = app
                            .notification()
                            .builder()
                            .title("HomePlace Desktop")
                            .body("The selected server could not be activated.")
                            .show();
                    }
                }
                return;
            }

            match tray_command(id) {
                Some(TrayCommand::Show) => show_main_window(app),
                Some(TrayCommand::Reconnect) => {
                    if let Some(service) = app.try_state::<crate::link::client::HeartbeatService>()
                    {
                        service.wake();
                    }
                }
                Some(TrayCommand::Quit) => app.exit(0),
                None => {}
            }
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

fn build_menu<R: Runtime, M: Manager<R>>(app: &M) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, "open", "Open HomePlace", true, None::<&str>)?;
    let reconnect = MenuItem::with_id(app, "reconnect", "Reconnect now", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit HomePlace", true, None::<&str>)?;

    let profiles = crate::link::identity::load_profiles().unwrap_or_default();
    let active_server_id = crate::link::identity::load_profile()
        .ok()
        .flatten()
        .map(|profile| profile.server_id);
    let mut profile_items = Vec::with_capacity(profiles.len().max(1));
    if profiles.is_empty() {
        profile_items.push(MenuItem::with_id(
            app,
            "profile:none",
            "No paired servers",
            false,
            None::<&str>,
        )?);
    } else {
        for profile in profiles {
            let marker = if active_server_id.as_deref() == Some(&profile.server_id) {
                "✓ "
            } else {
                ""
            };
            let label = format!("{marker}{}", menu_label(&profile.server_name));
            profile_items.push(MenuItem::with_id(
                app,
                format!("profile:{}", profile.server_id),
                label,
                true,
                None::<&str>,
            )?);
        }
    }
    let profile_refs: Vec<&dyn IsMenuItem<R>> = profile_items
        .iter()
        .map(|item| item as &dyn IsMenuItem<R>)
        .collect();
    let servers = Submenu::with_items(app, "Servers", true, &profile_refs)?;

    Menu::with_items(app, &[&open, &servers, &reconnect, &separator, &quit])
}

pub fn refresh_menu<R: Runtime>(app: &AppHandle<R>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Ok(menu) = build_menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
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
        ConnectionState::Interrupted => "HomePlace Desktop — Reconnecting",
        ConnectionState::NotConfigured => "HomePlace Desktop — Not configured",
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
        .body("Link remains active in the system tray. Use Quit HomePlace to stop it.")
        .show();
}

fn tray_command(id: &str) -> Option<TrayCommand> {
    match id {
        "open" => Some(TrayCommand::Show),
        "reconnect" => Some(TrayCommand::Reconnect),
        "quit" => Some(TrayCommand::Quit),
        _ => None,
    }
}

fn profile_server_id(id: &str) -> Option<&str> {
    let server_id = id.strip_prefix("profile:")?;
    uuid::Uuid::parse_str(server_id).ok()?;
    Some(server_id)
}

fn menu_label(value: &str) -> String {
    let mut label: String = value.chars().take(48).collect();
    if value.chars().count() > 48 {
        label.push('…');
    }
    label.replace('&', "&&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_only_known_tray_commands() {
        assert_eq!(tray_command("open"), Some(TrayCommand::Show));
        assert_eq!(tray_command("reconnect"), Some(TrayCommand::Reconnect));
        assert_eq!(tray_command("quit"), Some(TrayCommand::Quit));
        assert_eq!(tray_command("notification.deliver"), None);
    }

    #[test]
    fn accepts_only_uuid_profile_menu_ids() {
        assert_eq!(
            profile_server_id("profile:e54f9bfa-2543-4be2-bc07-c1eb3d0947ee"),
            Some("e54f9bfa-2543-4be2-bc07-c1eb3d0947ee")
        );
        assert_eq!(profile_server_id("profile:none"), None);
        assert_eq!(profile_server_id("profile:../../credential"), None);
    }

    #[test]
    fn bounds_and_escapes_profile_labels() {
        assert_eq!(menu_label("Home & Lab"), "Home && Lab");
        assert!(menu_label(&"a".repeat(80)).chars().count() <= 49);
    }
}
