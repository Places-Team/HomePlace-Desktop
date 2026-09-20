use super::PlatformInfo;

pub fn info() -> PlatformInfo {
    PlatformInfo {
        platform: "macos",
        label: "macOS",
        secure_storage: "Keychain",
        tray: true,
    }
}
