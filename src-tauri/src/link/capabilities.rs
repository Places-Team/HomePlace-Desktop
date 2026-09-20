use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub name: &'static str,
    pub version: u8,
}

pub fn initial_capabilities() -> Vec<Capability> {
    vec![
        Capability {
            name: "notification.receive",
            version: 1,
        },
        Capability {
            name: "device.presence",
            version: 1,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffold_advertises_only_implemented_capabilities() {
        let capabilities = initial_capabilities();
        assert_eq!(capabilities.len(), 2);
        assert!(!capabilities.iter().any(|item| item.name == "system.shell"));
    }
}
