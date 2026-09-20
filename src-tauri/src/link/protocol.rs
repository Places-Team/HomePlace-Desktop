use serde::Deserialize;

pub const PROTOCOL_MIN: u16 = 1;
pub const PROTOCOL_MAX: u16 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    pub product: String,
    pub server: ServerIdentity,
    pub protocol: ProtocolRange,
    pub server_time: String,
    pub features: LinkFeatures,
}

#[derive(Debug, Deserialize)]
pub struct ServerIdentity {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct ProtocolRange {
    pub min: u16,
    pub max: u16,
}

#[derive(Debug, Deserialize)]
pub struct LinkFeatures {
    pub pairing: bool,
    pub realtime: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ProtocolError {
    WrongProduct,
    InvalidServerIdentity,
    IncompatibleVersion,
    PairingUnavailable,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ValidatedLinkInfo<'a> {
    pub server_id: &'a str,
    pub server_name: &'a str,
    pub server_time: &'a str,
    pub realtime: bool,
}

pub fn validate_link_info(info: &LinkInfo) -> Result<ValidatedLinkInfo<'_>, ProtocolError> {
    if info.product != "HomePlace" {
        return Err(ProtocolError::WrongProduct);
    }
    if info.server.id.trim().is_empty() || info.server.name.trim().is_empty() {
        return Err(ProtocolError::InvalidServerIdentity);
    }
    if info.protocol.max < PROTOCOL_MIN || info.protocol.min > PROTOCOL_MAX {
        return Err(ProtocolError::IncompatibleVersion);
    }
    if !info.features.pairing {
        return Err(ProtocolError::PairingUnavailable);
    }
    Ok(ValidatedLinkInfo {
        server_id: &info.server.id,
        server_name: &info.server.name,
        server_time: &info.server_time,
        realtime: info.features.realtime,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compatible() -> LinkInfo {
        LinkInfo {
            product: "HomePlace".into(),
            server: ServerIdentity {
                id: "server-id".into(),
                name: "Home".into(),
            },
            protocol: ProtocolRange { min: 1, max: 1 },
            server_time: "2026-09-20T12:00:00Z".into(),
            features: LinkFeatures {
                pairing: true,
                realtime: false,
            },
        }
    }

    #[test]
    fn accepts_a_compatible_homeplace_server() {
        let info = compatible();
        let validated = validate_link_info(&info).expect("compatible server");
        assert_eq!(validated.server_id, "server-id");
        assert_eq!(validated.server_name, "Home");
        assert_eq!(validated.server_time, "2026-09-20T12:00:00Z");
        assert!(!validated.realtime);
    }

    #[test]
    fn rejects_incompatible_or_unpairable_servers() {
        let mut info = compatible();
        info.protocol.min = 2;
        assert_eq!(
            validate_link_info(&info),
            Err(ProtocolError::IncompatibleVersion)
        );

        let mut info = compatible();
        info.features.pairing = false;
        assert_eq!(
            validate_link_info(&info),
            Err(ProtocolError::PairingUnavailable)
        );
    }
}
