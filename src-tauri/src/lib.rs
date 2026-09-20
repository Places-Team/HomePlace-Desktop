mod link;
mod platform;

use platform::PlatformInfo;
use serde::Serialize;

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
        .invoke_handler(tauri::generate_handler![
            platform_info,
            link::client::verify_server,
            link::client::start_pairing,
            link::client::poll_pairing
        ])
        .run(tauri::generate_context!())
        .expect("failed to run HomePlace Desktop");
}
