use super::PlatformInfo;

pub fn info() -> PlatformInfo {
    PlatformInfo {
        platform: "linux",
        label: "Linux",
        secure_storage: "Secret Service",
        tray: true,
    }
}
