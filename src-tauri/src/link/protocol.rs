use serde::Deserialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

pub const PROTOCOL_MIN: u16 = 1;
pub const PROTOCOL_MAX: u16 = 1;
const MAX_CLOCK_SKEW_SECONDS: i64 = 10 * 60;

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
    InvalidServerTime,
    ClockSkew,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ValidatedLinkInfo<'a> {
    pub server_id: &'a str,
    pub server_name: &'a str,
    pub realtime: bool,
}

pub fn validate_link_info(
    info: &LinkInfo,
    now: OffsetDateTime,
) -> Result<ValidatedLinkInfo<'_>, ProtocolError> {
    if info.product != "HomePlace" {
        return Err(ProtocolError::WrongProduct);
    }
    if Uuid::parse_str(info.server.id.trim()).is_err() || info.server.name.trim().is_empty() {
        return Err(ProtocolError::InvalidServerIdentity);
    }
    if info.protocol.max < PROTOCOL_MIN || info.protocol.min > PROTOCOL_MAX {
        return Err(ProtocolError::IncompatibleVersion);
    }
    if !info.features.pairing {
        return Err(ProtocolError::PairingUnavailable);
    }

    let server_time = OffsetDateTime::parse(&info.server_time, &Rfc3339)
        .map_err(|_| ProtocolError::InvalidServerTime)?;
    if (now - server_time).whole_seconds().abs() > MAX_CLOCK_SKEW_SECONDS {
        return Err(ProtocolError::ClockSkew);
    }

    Ok(ValidatedLinkInfo {
        server_id: &info.server.id,
        server_name: &info.server.name,
        realtime: info.features.realtime,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> OffsetDateTime {
        OffsetDateTime::parse("2026-09-20T12:05:00Z", &Rfc3339).unwrap()
    }

    fn compatible() -> LinkInfo {
        LinkInfo {
            product: "HomePlace".into(),
            server: ServerIdentity {
                id: "e54f9bfa-2543-4be2-bc07-c1eb3d0947ee".into(),
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
    fn accepts_a_compatible_server() {
        let info = compatible();
        let validated = validate_link_info(&info, now()).unwrap();

        assert_eq!(validated.server_id, "e54f9bfa-2543-4be2-bc07-c1eb3d0947ee");
        assert_eq!(validated.server_name, "Home");
        assert!(!validated.realtime);
    }

    #[test]
    fn rejects_an_incompatible_protocol() {
        let mut info = compatible();
        info.protocol.min = 2;

        assert_eq!(
            validate_link_info(&info, now()),
            Err(ProtocolError::IncompatibleVersion)
        );
    }

    #[test]
    fn rejects_invalid_identity_and_disabled_pairing() {
        let mut info = compatible();
        info.server.id = "not-a-uuid".into();
        assert_eq!(
            validate_link_info(&info, now()),
            Err(ProtocolError::InvalidServerIdentity)
        );

        let mut info = compatible();
        info.features.pairing = false;
        assert_eq!(
            validate_link_info(&info, now()),
            Err(ProtocolError::PairingUnavailable)
        );
    }

    #[test]
    fn rejects_invalid_or_stale_server_time() {
        let mut info = compatible();
        info.server_time = "yesterday".into();
        assert_eq!(
            validate_link_info(&info, now()),
            Err(ProtocolError::InvalidServerTime)
        );

        let mut info = compatible();
        info.server_time = "2026-09-20T11:54:59Z".into();
        assert_eq!(
            validate_link_info(&info, now()),
            Err(ProtocolError::ClockSkew)
        );
    }
}
