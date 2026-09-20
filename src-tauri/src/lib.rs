mod link;
mod platform;
mod startup;
mod tray;

use std::sync::atomic::{AtomicBool, Ordering};

use platform::PlatformInfo;
use serde::Serialize;
use tauri::Manager;

static QUICK_SHARE_WAS_FOCUSED: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapInfo {
    #[serde(flatten)]
    platform: PlatformInfo,
    capabilities: Vec<link::Capability>,
    protocol_min: u16,
    protocol_max: u16,
}

#[tauri::command]
fn platform_info() -> BootstrapInfo {
    BootstrapInfo {
        platform: platform::current(),
        capabilities: link::initial_capabilities(),
        protocol_min: link::protocol::PROTOCOL_MIN,
        protocol_max: link::protocol::PROTOCOL_MAX,
    }
}

#[tauri::command]
fn start_window_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|_| "Could not start moving the HomePlace window.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _working_directory| {
                tray::show_main_window(app);
                if let Some(service) = app.try_state::<link::client::HeartbeatService>() {
                    service.wake();
                }
            },
        ))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--hidden"])
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Some Linux desktop environments do not provide a tray host. In
            // that case HomePlace keeps its normal close behaviour.
            let _ = tray::install(app);
            let heartbeat = link::client::start_heartbeat_service(app.handle().clone());
            app.manage(heartbeat);
            if startup::starts_hidden()
                && app.tray_by_id(tray::TRAY_ID).is_some()
                && let Some(window) = app.get_webview_window("main")
            {
                let _ = window.hide();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "quick-share" {
                match event {
                    tauri::WindowEvent::Focused(focused) => {
                        if *focused {
                            QUICK_SHARE_WAS_FOCUSED.store(true, Ordering::Relaxed);
                        } else if QUICK_SHARE_WAS_FOCUSED.swap(false, Ordering::Relaxed) {
                            let _ = window.hide();
                        }
                    }
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        QUICK_SHARE_WAS_FOCUSED.store(false, Ordering::Relaxed);
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    _ => {}
                }
                return;
            }
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.app_handle().tray_by_id(tray::TRAY_ID).is_some()
            {
                api.prevent_close();
                let _ = window.hide();
                tray::notify_window_hidden(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            platform_info,
            start_window_drag,
            tray::set_quick_share_pointer_inside,
            startup::startup_status,
            startup::set_startup_enabled,
            link::client::verify_server,
            link::client::start_pairing,
            link::client::poll_pairing,
            link::client::connection_profile,
            link::client::connection_profiles,
            link::client::activate_profile,
            link::client::cancel_pairing,
            link::client::clipboard_sync_status,
            link::client::set_clipboard_sync,
            link::client::clipboard_history,
            link::client::clear_clipboard_history,
            link::client::list_share_targets,
            link::client::send_share_text,
            link::client::send_share_file,
            link::client::list_reminders,
            link::client::list_calendar_events,
            link::client::create_calendar_event,
            link::client::update_calendar_event,
            link::client::delete_calendar_event,
            link::client::create_reminder,
            link::client::update_reminder,
            link::client::complete_reminder,
            link::client::delete_reminder,
            link::client::resolve_share_offer,
            link::client::request_heartbeat,
            link::client::disconnect_device
        ])
        .build(tauri::generate_context!())
        .expect("failed to build HomePlace Desktop");

    app.run(|app, event| match event {
        tauri::RunEvent::Resumed => {
            if let Some(service) = app.try_state::<link::client::HeartbeatService>() {
                service.wake();
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => tray::show_main_window(app),
        _ => {}
    });
}
