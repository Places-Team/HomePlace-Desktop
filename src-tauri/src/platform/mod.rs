use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub platform: &'static str,
    pub label: &'static str,
    pub secure_storage: &'static str,
    pub tray: bool,
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
