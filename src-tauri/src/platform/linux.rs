use super::PlatformInfo;

pub fn info() -> PlatformInfo {
    PlatformInfo {
        platform: "linux",
        label: "Linux",
        secure_storage: "Secret Service",
        tray: true,
        device_name: super::device_name("Linux PC"),
        platform_version: super::platform_version(),
    }
}
