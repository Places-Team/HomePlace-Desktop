mod link;
mod platform;
mod startup;
mod tray;

use platform::PlatformInfo;
use serde::Serialize;
use tauri::Manager;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--hidden"])
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
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
            startup::startup_status,
            startup::set_startup_enabled,
            link::client::verify_server,
            link::client::start_pairing,
            link::client::poll_pairing,
            link::client::connection_profile,
            link::client::request_heartbeat,
            link::client::disconnect_device
        ])
        .run(tauri::generate_context!())
        .expect("failed to run HomePlace Desktop");
}
