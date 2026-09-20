use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub name: &'static str,
    pub version: u8,
    pub constraints: BTreeMap<&'static str, &'static str>,
}

pub fn initial_capabilities() -> Vec<Capability> {
    vec![
        Capability {
            name: "notification.receive",
            version: 1,
            constraints: BTreeMap::new(),
        },
        Capability {
            name: "device.presence",
            version: 1,
            constraints: BTreeMap::new(),
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
        assert!(
            capabilities
                .iter()
                .any(|item| item.name == "notification.receive")
        );
        assert!(
            capabilities
                .iter()
                .any(|item| item.name == "device.presence")
        );
        assert!(!capabilities.iter().any(|item| item.name == "system.shell"));
    }
}
