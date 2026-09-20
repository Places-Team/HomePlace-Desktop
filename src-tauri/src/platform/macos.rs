use super::PlatformInfo;

pub fn info() -> PlatformInfo {
    PlatformInfo {
        platform: "macos",
        label: "macOS",
        secure_storage: "Keychain",
        tray: true,
        device_name: super::device_name("Mac"),
        platform_version: super::platform_version(),
    }
}
