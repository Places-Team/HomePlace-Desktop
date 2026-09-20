use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{Client, redirect::Policy};
use serde::Serialize;
use time::OffsetDateTime;
use url::{Host, Url};

use super::protocol::{LinkInfo, ProtocolError, validate_link_info};

const MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedServer {
    address: String,
    server_id: String,
    server_name: String,
    realtime: bool,
    reduced_security: bool,
}

#[tauri::command]
pub async fn verify_server(address: String) -> Result<VerifiedServer, String> {
    let (base_url, reduced_security) = validate_address(&address)?;
    let info_url = base_url
        .join("api/link/info")
        .map_err(|_| "Could not create the Link API address.".to_string())?;

    let client = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "Could not initialise the secure connection.".to_string())?;

    let response = client
        .get(info_url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| connection_error(&error))?;

    if response.status().is_redirection() {
        return Err(
            "The server redirected the Link API request. Enter its final address instead.".into(),
        );
    }
    if !response.status().is_success() {
        return Err(format!(
            "The Link API returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err("The Link API response is larger than allowed.".into());
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The Link API response could not be read.".to_string())?;
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("The Link API response is larger than allowed.".into());
        }
        body.extend_from_slice(&chunk);
    }

    let info: LinkInfo = serde_json::from_slice(&body)
        .map_err(|_| "The server returned an invalid Link API response.".to_string())?;
    let validated = validate_link_info(&info, OffsetDateTime::now_utc()).map_err(protocol_error)?;

    Ok(VerifiedServer {
        address: canonical_address(&base_url),
        server_id: validated.server_id.to_owned(),
        server_name: validated.server_name.to_owned(),
        realtime: validated.realtime,
        reduced_security,
    })
}

fn validate_address(input: &str) -> Result<(Url, bool), String> {
    let trimmed = input.trim();
    let mut url = Url::parse(trimmed)
        .map_err(|_| "Enter a complete address starting with http:// or https://.".to_string())?;

    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http:// and https:// server addresses are supported.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Do not include credentials in the server address.".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Do not include a query or fragment in the server address.".into());
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err("Enter the HomePlace server address without an extra path.".into());
    }

    let host = url
        .host()
        .ok_or_else(|| "The server address must include a host.".to_string())?;
    let reduced_security = url.scheme() == "http";
    if reduced_security && !is_local_host(host) {
        return Err("Public HomePlace servers require HTTPS.".into());
    }

    url.set_path("/");
    Ok((url, reduced_security))
}

fn is_local_host(host: Host<&str>) -> bool {
    match host {
        Host::Ipv4(address) => {
            address.is_private() || address.is_loopback() || address.is_link_local()
        }
        Host::Ipv6(address) => {
            address.is_loopback() || address.is_unique_local() || address.is_unicast_link_local()
        }
        Host::Domain(name) => {
            name.eq_ignore_ascii_case("localhost")
                || name.ends_with(".local")
                || !name.contains('.')
        }
    }
}

fn canonical_address(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_owned()
}

fn connection_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The HomePlace server did not respond within 8 seconds.".into()
    } else if error.is_connect() {
        "Could not connect to the HomePlace server.".into()
    } else {
        "The Link API request failed.".into()
    }
}

fn protocol_error(error: ProtocolError) -> String {
    match error {
        ProtocolError::WrongProduct => "This server is not a HomePlace server.",
        ProtocolError::InvalidServerIdentity => "The server identity is invalid.",
        ProtocolError::IncompatibleVersion => {
            "This HomePlace server uses an incompatible Link protocol."
        }
        ProtocolError::PairingUnavailable => "Pairing is not enabled on this HomePlace server.",
        ProtocolError::InvalidServerTime => "The HomePlace server returned an invalid time.",
        ProtocolError::ClockSkew => {
            "The server clock differs by more than 10 minutes. Correct it before pairing."
        }
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permits_https_and_local_http() {
        assert!(validate_address("https://home.example.net").is_ok());
        assert!(validate_address("http://192.168.1.20:3200").is_ok());
        assert!(validate_address("http://[fd00::1]:3200").is_ok());
        assert!(validate_address("http://homeplace.local:3200").is_ok());
    }

    #[test]
    fn rejects_public_http_and_ambiguous_addresses() {
        assert!(validate_address("http://example.net").is_err());
        assert!(validate_address("ftp://192.168.1.20").is_err());
        assert!(validate_address("https://user:pass@example.net").is_err());
        assert!(validate_address("https://example.net/path").is_err());
        assert!(validate_address("https://example.net?token=secret").is_err());
    }

    #[test]
    fn normalises_the_canonical_address() {
        let (url, reduced_security) = validate_address(" http://192.168.1.20:3200/ ").unwrap();
        assert_eq!(canonical_address(&url), "http://192.168.1.20:3200");
        assert!(reduced_security);
    }

    #[test]
    #[ignore = "requires HOMEPLACE_TEST_SERVER to point to a live HomePlace server"]
    fn verifies_a_configured_live_server() {
        let address = std::env::var("HOMEPLACE_TEST_SERVER")
            .expect("HOMEPLACE_TEST_SERVER must contain a HomePlace server address");
        let verified = tauri::async_runtime::block_on(verify_server(address)).unwrap();

        assert!(!verified.server_id.is_empty());
        assert!(!verified.server_name.is_empty());
    }
}
