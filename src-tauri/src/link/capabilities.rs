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
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffold_advertises_only_implemented_capabilities() {
        let capabilities = initial_capabilities();
        assert!(capabilities.is_empty());
        assert!(!capabilities.iter().any(|item| item.name == "system.shell"));
    }
}
