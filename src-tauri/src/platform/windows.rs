use super::PlatformInfo;

pub fn info() -> PlatformInfo {
    PlatformInfo {
        platform: "windows",
        label: "Windows",
        secure_storage: "Credential Manager",
        tray: true,
    }
}
