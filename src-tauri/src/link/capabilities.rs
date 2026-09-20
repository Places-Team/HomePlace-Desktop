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
        Capability {
            name: "url.open",
            version: 1,
            constraints: BTreeMap::from([("confirmation", "required")]),
        },
        Capability {
            name: "text.receive",
            version: 1,
            constraints: BTreeMap::from([("confirmation", "required")]),
        },
        Capability {
            name: "clipboard.receive",
            version: 1,
            constraints: BTreeMap::from([("confirmation", "required")]),
        },
        Capability {
            name: "clipboard.send",
            version: 1,
            constraints: BTreeMap::from([("policy", "user-controlled")]),
        },
        Capability {
            name: "file.receive",
            version: 1,
            constraints: BTreeMap::from([("confirmation", "required"), ("maxBytes", "5242880")]),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffold_advertises_only_implemented_capabilities() {
        let capabilities = initial_capabilities();
        assert_eq!(capabilities.len(), 7);
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
        assert!(capabilities.iter().any(|item| item.name == "url.open"));
        assert!(capabilities.iter().any(|item| item.name == "text.receive"));
        assert!(
            capabilities
                .iter()
                .any(|item| item.name == "clipboard.receive")
        );
        assert!(
            capabilities
                .iter()
                .any(|item| item.name == "clipboard.send")
        );
        assert!(capabilities.iter().any(|item| item.name == "file.receive"));
        assert!(!capabilities.iter().any(|item| item.name == "system.shell"));
    }
}
