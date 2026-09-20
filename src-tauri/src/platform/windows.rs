use super::PlatformInfo;

pub fn info() -> PlatformInfo {
    PlatformInfo {
        platform: "windows",
        label: "Windows",
        secure_storage: "Credential Manager",
        tray: true,
        device_name: super::device_name("Windows PC"),
        platform_version: super::platform_version(),
    }
}
