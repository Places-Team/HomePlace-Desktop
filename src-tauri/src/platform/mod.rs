use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub platform: &'static str,
    pub label: &'static str,
    pub secure_storage: &'static str,
    pub tray: bool,
    pub device_name: String,
    pub platform_version: String,
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

pub fn current() -> PlatformInfo {
    #[cfg(target_os = "macos")]
    return macos::info();
    #[cfg(target_os = "windows")]
    return windows::info();
    #[cfg(target_os = "linux")]
    return linux::info();
}

pub fn device_name(fallback: &str) -> String {
    hostname::get()
        .ok()
        .and_then(|name| name.into_string().ok())
        .map(|name| name.trim().chars().take(80).collect::<String>())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| format!("HomePlace {fallback}"))
}

pub fn platform_version() -> String {
    let version: String = os_info::get()
        .version()
        .to_string()
        .chars()
        .take(40)
        .collect();
    if version.trim().is_empty() {
        "Unknown".into()
    } else {
        version
    }
}
