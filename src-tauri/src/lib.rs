mod link;
mod native;
mod platform;
mod startup;
mod tray;

use std::sync::atomic::{AtomicBool, Ordering};

use platform::PlatformInfo;
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

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

#[tauri::command]
fn set_quick_share_expanded(window: tauri::WebviewWindow, expanded: bool) -> Result<(), String> {
    if window.label() != "quick-share" {
        return Err("Only the quick-share window can use shelf sizing.".into());
    }
    let scale = window
        .scale_factor()
        .map_err(|_| "Could not read the quick-share display scale.".to_string())?;
    let old_position = window
        .outer_position()
        .map_err(|_| "Could not read the quick-share position.".to_string())?;
    let old_size = window
        .outer_size()
        .map_err(|_| "Could not read the quick-share size.".to_string())?;
    let logical_size = if expanded {
        tauri::LogicalSize::new(420.0, 500.0)
    } else {
        tauri::LogicalSize::new(104.0, 56.0)
    };
    let physical_size = logical_size.to_physical::<u32>(scale);
    let monitor = window
        .current_monitor()
        .map_err(|_| "Could not locate the quick-share display.".to_string())?;
    let grows_up = monitor.as_ref().is_some_and(|monitor| {
        old_position.y > monitor.position().y + monitor.size().height as i32 / 2
    });
    let mut x = old_position.x + (old_size.width as i32 - physical_size.width as i32) / 2;
    let mut y = if grows_up {
        old_position.y + old_size.height as i32 - physical_size.height as i32
    } else {
        old_position.y
    };
    if let Some(monitor) = monitor {
        let min_x = monitor.position().x + 8;
        let min_y = monitor.position().y + 8;
        let max_x =
            monitor.position().x + monitor.size().width as i32 - physical_size.width as i32 - 8;
        let max_y =
            monitor.position().y + monitor.size().height as i32 - physical_size.height as i32 - 8;
        x = x.clamp(min_x, max_x.max(min_x));
        y = y.clamp(min_y, max_y.max(min_y));
    }
    window
        .set_size(logical_size)
        .map_err(|_| "Could not resize the quick-share shelf.".to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|_| "Could not reposition the quick-share shelf.".to_string())
}

#[tauri::command]
async fn pick_share_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let selected = app
        .dialog()
        .file()
        .blocking_pick_files()
        .unwrap_or_default();
    selected
        .into_iter()
        .take(20)
        .map(|selected| {
            selected
                .into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|_| "A selected file path is unavailable.".to_string())
        })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, arguments, _working_directory| {
                if !native::dispatch_share_arguments(app, &arguments) {
                    tray::show_main_window(app);
                }
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
            native::start_drag_monitor(app.handle().clone());
            let heartbeat = link::client::start_heartbeat_service(app.handle().clone());
            app.manage(heartbeat);
            let share_app = app.handle().clone();
            let share_arguments: Vec<String> = std::env::args().collect();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(650)).await;
                native::dispatch_share_arguments(&share_app, &share_arguments);
            });
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
                        } else if QUICK_SHARE_WAS_FOCUSED.swap(false, Ordering::Relaxed)
                            && !tray::quick_share_is_pinned()
                        {
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
            set_quick_share_expanded,
            pick_share_files,
            native::authenticate_sensitive_action,
            native::take_pending_share,
            tray::open_quick_share,
            tray::set_quick_share_pointer_inside,
            tray::set_quick_share_pinned,
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
            link::client::system_notification_status,
            link::client::set_system_notifications,
            link::client::clipboard_history,
            link::client::clear_clipboard_history,
            link::client::remove_clipboard_history,
            link::client::list_share_targets,
            link::client::list_account_devices,
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
            link::client::restore_reminder,
            link::client::clear_completed_reminders,
            link::client::list_completed_reminders,
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
