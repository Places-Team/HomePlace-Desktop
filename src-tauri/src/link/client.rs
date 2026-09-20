use std::{collections::HashSet, time::Duration};

use futures_util::StreamExt;
use reqwest::{Client, Response, redirect::Policy};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_notification::NotificationExt;
use time::{Duration as TimeDuration, OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{sync::mpsc, time::sleep};
use url::{Host, Url};
use zeroize::Zeroizing;

use super::{
    capabilities::initial_capabilities,
    identity::{self, PendingPairing, StoredProfile},
    protocol::{LinkInfo, PROTOCOL_MAX, ProtocolError, validate_link_info},
};
use crate::platform;

const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const HEARTBEAT_EVENT: &str = "link-heartbeat";
const HEALTHY_HEARTBEAT_SECONDS: u64 = 30;
const MAX_RETRY_SECONDS: u64 = 5 * 60;

pub struct HeartbeatService {
    wake: mpsc::Sender<()>,
}

impl HeartbeatService {
    pub fn wake(&self) {
        let _ = self.wake.try_send(());
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedServer {
    address: String,
    server_id: String,
    server_name: String,
    realtime: bool,
    reduced_security: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingSession {
    code: String,
    expires_at: String,
    poll_after_seconds: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    status: String,
    device_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfiles {
    profiles: Vec<StoredProfile>,
    active_server_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatStatus {
    server_time: String,
    pending_events: usize,
    delivered_notifications: usize,
    notification_failures: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum HeartbeatUpdate {
    Connected {
        server_time: String,
        pending_events: usize,
        delivered_notifications: usize,
        notification_failures: usize,
    },
    Failed {
        message: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NotificationContent {
    title: String,
    body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    protocol: u16,
    device: PairDevice,
    public_key: String,
    capabilities: Vec<super::capabilities::Capability>,
    permissions: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairDevice {
    name: String,
    platform: &'static str,
    platform_version: String,
    app_version: &'static str,
}

#[derive(Deserialize)]
struct PairEnvelope {
    protocol: u16,
    pairing: PairingCreated,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingCreated {
    id: String,
    code: String,
    claim_secret: String,
    expires_at: String,
    poll_after_seconds: u64,
}

#[derive(Deserialize)]
struct ClaimEnvelope {
    protocol: u16,
    pairing: ClaimResult,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimResult {
    status: String,
    server_id: Option<String>,
    device_id: Option<String>,
    credential: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatEnvelope {
    protocol: u16,
    server_id: String,
    server_time: String,
    events: Vec<HeartbeatEvent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatEvent {
    protocol: u16,
    id: String,
    #[serde(rename = "type")]
    kind: String,
    device_id: String,
    sent_at: String,
    payload: serde_json::Value,
}

#[tauri::command]
pub async fn verify_server(address: String) -> Result<VerifiedServer, String> {
    let (base_url, reduced_security) = validate_address(&address)?;
    let info_url = base_url
        .join("api/link/info")
        .map_err(|_| "Could not create the Link API address.".to_string())?;

    let client = http_client()?;

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

#[tauri::command]
pub async fn start_pairing(
    address: String,
    server_id: String,
    device_name: String,
) -> Result<PairingSession, String> {
    let verified = verify_server(address).await?;
    if verified.server_id != server_id {
        return Err("The HomePlace server identity changed. Verify the address again.".into());
    }

    let name = bounded_device_name(&device_name)?;
    let platform = platform::current();
    let public_key = identity::public_key(&server_id)?;
    let request = PairRequest {
        protocol: PROTOCOL_MAX,
        device: PairDevice {
            name,
            platform: platform.platform,
            platform_version: platform.platform_version,
            app_version: env!("CARGO_PKG_VERSION"),
        },
        public_key,
        capabilities: initial_capabilities(),
        permissions: Vec::new(),
    };

    let base_url = Url::parse(&verified.address)
        .map_err(|_| "The verified server address is invalid.".to_string())?;
    let response = http_client()?
        .post(
            base_url
                .join("api/link/pair")
                .map_err(|_| "Could not create the pairing API address.".to_string())?,
        )
        .header("Accept", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|error| connection_error(&error))?;

    if response.status().as_u16() == 429 {
        return Err("Too many pairing attempts. Wait a minute and try again.".into());
    }
    ensure_success(&response, "pairing")?;
    let envelope: PairEnvelope = read_bounded_json(response).await?;
    validate_pairing_response(&envelope)?;

    identity::store_pending(
        &server_id,
        &PendingPairing {
            pairing_id: envelope.pairing.id.clone(),
            claim_secret: envelope.pairing.claim_secret.clone(),
            expires_at: envelope.pairing.expires_at.clone(),
            address: verified.address,
            server_name: verified.server_name,
            device_name: request.device.name,
        },
    )?;

    Ok(PairingSession {
        code: envelope.pairing.code,
        expires_at: envelope.pairing.expires_at,
        poll_after_seconds: envelope.pairing.poll_after_seconds,
    })
}

#[tauri::command]
pub async fn poll_pairing(app: AppHandle, server_id: String) -> Result<PairingStatus, String> {
    if uuid::Uuid::parse_str(&server_id).is_err() {
        return Err("The stored HomePlace server identity is invalid.".into());
    }
    let pending = identity::load_pending(&server_id)?;
    let expiry = OffsetDateTime::parse(&pending.expires_at, &Rfc3339)
        .map_err(|_| "The stored pairing session has an invalid expiry time.".to_string())?;
    if expiry <= OffsetDateTime::now_utc() {
        identity::delete_pending(&server_id)?;
        return Ok(PairingStatus {
            status: "expired".into(),
            device_id: None,
        });
    }

    let verified = verify_server(pending.address.clone()).await?;
    if verified.server_id != server_id {
        return Err("The HomePlace server identity changed during pairing.".into());
    }
    let base_url = Url::parse(&verified.address)
        .map_err(|_| "The stored HomePlace server address is invalid.".to_string())?;
    let endpoint = base_url
        .join(&format!("api/link/pairing/{}/claim", pending.pairing_id))
        .map_err(|_| "Could not create the pairing claim address.".to_string())?;
    let response = http_client()?
        .post(endpoint)
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "claimSecret": pending.claim_secret }))
        .send()
        .await
        .map_err(|error| connection_error(&error))?;

    ensure_success(&response, "pairing claim")?;
    let envelope: ClaimEnvelope = read_bounded_json(response).await?;
    if envelope.protocol != PROTOCOL_MAX {
        return Err("The pairing claim used an incompatible Link protocol.".into());
    }

    match envelope.pairing.status.as_str() {
        "pending" => Ok(PairingStatus {
            status: "pending".into(),
            device_id: None,
        }),
        "approved" => {
            let returned_server_id = envelope.pairing.server_id.as_deref().ok_or_else(|| {
                "The approved pairing response has no server identity.".to_string()
            })?;
            if returned_server_id != server_id {
                return Err("The approved pairing response came from a different server.".into());
            }
            let device_id = envelope
                .pairing
                .device_id
                .filter(|value| safe_identifier(value))
                .ok_or_else(|| {
                    "The approved pairing response has an invalid device ID.".to_string()
                })?;
            let credential = envelope
                .pairing
                .credential
                .filter(|value| valid_secret(value))
                .map(Zeroizing::new)
                .ok_or_else(|| {
                    "The approved pairing response has an invalid credential.".to_string()
                })?;

            identity::store_credential(&server_id, &credential)?;
            identity::store_profile(&StoredProfile {
                server_id: server_id.clone(),
                server_name: pending.server_name,
                address: pending.address,
                device_id: device_id.clone(),
                device_name: pending.device_name,
            })?;
            crate::tray::refresh_menu(&app);
            identity::delete_pending(&server_id)?;
            Ok(PairingStatus {
                status: "approved".into(),
                device_id: Some(device_id),
            })
        }
        "rejected" | "expired" => {
            identity::delete_pending(&server_id)?;
            Ok(PairingStatus {
                status: envelope.pairing.status,
                device_id: None,
            })
        }
        "claimed" => {
            identity::delete_pending(&server_id)?;
            Err("This pairing credential was already claimed. Start pairing again.".into())
        }
        _ => Err("The HomePlace server returned an unknown pairing status.".into()),
    }
}

#[tauri::command]
pub fn connection_profile() -> Result<Option<StoredProfile>, String> {
    let Some(profile) = identity::load_profile()? else {
        return Ok(None);
    };
    validate_stored_profile(&profile)?;
    identity::load_credential(&profile.server_id)?;
    Ok(Some(profile))
}

#[tauri::command]
pub fn connection_profiles() -> Result<ConnectionProfiles, String> {
    let profiles = identity::load_profiles()?;
    for profile in &profiles {
        validate_stored_profile(profile)?;
        identity::load_credential(&profile.server_id)?;
    }

    let active = identity::load_profile()?;
    let active_server_id = match active {
        Some(profile) => {
            validate_stored_profile(&profile)?;
            if !profiles
                .iter()
                .any(|stored| stored.server_id == profile.server_id)
            {
                return Err("The active HomePlace server is missing from the server list.".into());
            }
            Some(profile.server_id)
        }
        None if profiles.is_empty() => None,
        None => return Err("The active HomePlace server profile is missing.".into()),
    };

    Ok(ConnectionProfiles {
        profiles,
        active_server_id,
    })
}

#[tauri::command]
pub fn activate_profile(
    app: AppHandle,
    server_id: String,
    service: State<'_, HeartbeatService>,
) -> Result<StoredProfile, String> {
    let profile = activate_stored_profile(&server_id)?;
    crate::tray::refresh_menu(&app);
    service.wake();
    Ok(profile)
}

pub(crate) fn activate_stored_profile(server_id: &str) -> Result<StoredProfile, String> {
    if uuid::Uuid::parse_str(server_id).is_err() {
        return Err("The selected HomePlace server ID is invalid.".into());
    }
    let profile = identity::load_profiles()?
        .into_iter()
        .find(|profile| profile.server_id == server_id)
        .ok_or_else(|| "The selected HomePlace server profile was not found.".to_string())?;
    validate_stored_profile(&profile)?;
    identity::load_credential(&profile.server_id)?;
    identity::activate_profile(server_id)?;
    Ok(profile)
}

#[tauri::command]
pub fn cancel_pairing(server_id: String) -> Result<(), String> {
    if uuid::Uuid::parse_str(&server_id).is_err() {
        return Err("The HomePlace server ID is invalid.".into());
    }
    identity::delete_pending(&server_id)
}

async fn send_heartbeat(app: &AppHandle) -> Result<HeartbeatStatus, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;

    let envelope = heartbeat_request(&profile, credential.as_str(), &[]).await?;
    let (acknowledged_event_ids, delivered_notifications, notification_failures) =
        deliver_notifications(&envelope.events, |notification| {
            app.notification()
                .builder()
                .title(&notification.title)
                .body(&notification.body)
                .show()
                .map_err(|_| ())
        });

    let envelope = if acknowledged_event_ids.is_empty() {
        envelope
    } else {
        heartbeat_request(&profile, credential.as_str(), &acknowledged_event_ids).await?
    };

    Ok(HeartbeatStatus {
        server_time: envelope.server_time,
        pending_events: envelope.events.len(),
        delivered_notifications,
        notification_failures,
    })
}

pub fn start_heartbeat_service(app: AppHandle) -> HeartbeatService {
    let (wake, mut wake_requests) = mpsc::channel(1);
    tauri::async_runtime::spawn(async move {
        let mut failures = 0_u32;

        while wake_requests.recv().await.is_some() {
            loop {
                if identity::load_profile().ok().flatten().is_none() {
                    crate::tray::set_connection_state(
                        &app,
                        crate::tray::ConnectionState::NotConfigured,
                    );
                    break;
                }

                let result = send_heartbeat(&app).await;
                let delay = match result {
                    Ok(status) => {
                        failures = 0;
                        crate::tray::set_connection_state(
                            &app,
                            crate::tray::ConnectionState::Connected,
                        );
                        let _ = app.emit(
                            HEARTBEAT_EVENT,
                            HeartbeatUpdate::Connected {
                                server_time: status.server_time,
                                pending_events: status.pending_events,
                                delivered_notifications: status.delivered_notifications,
                                notification_failures: status.notification_failures,
                            },
                        );
                        Duration::from_secs(HEALTHY_HEARTBEAT_SECONDS)
                    }
                    Err(message) => {
                        failures = failures.saturating_add(1);
                        crate::tray::set_connection_state(
                            &app,
                            crate::tray::ConnectionState::Interrupted,
                        );
                        let _ = app.emit(HEARTBEAT_EVENT, HeartbeatUpdate::Failed { message });
                        heartbeat_retry_delay(failures)
                    }
                };

                tokio::select! {
                    _ = sleep(delay) => {}
                    request = wake_requests.recv() => {
                        if request.is_none() {
                            return;
                        }
                        failures = 0;
                    }
                }

                if identity::load_profile().ok().flatten().is_none() {
                    break;
                }
            }
        }
    });
    HeartbeatService { wake }
}

#[tauri::command]
pub fn request_heartbeat(service: State<'_, HeartbeatService>) {
    service.wake();
}

fn heartbeat_retry_delay(failures: u32) -> Duration {
    let exponent = failures.saturating_sub(1).min(4);
    Duration::from_secs(
        HEALTHY_HEARTBEAT_SECONDS
            .saturating_mul(1_u64 << exponent)
            .min(MAX_RETRY_SECONDS),
    )
}

async fn heartbeat_request(
    profile: &StoredProfile,
    credential: &str,
    acknowledged_event_ids: &[String],
) -> Result<HeartbeatEnvelope, String> {
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/heartbeat")
        .map_err(|_| "Could not create the heartbeat API address.".to_string())?;
    let response = http_client()?
        .post(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential)
        .json(&serde_json::json!({
            "protocol": PROTOCOL_MAX,
            "acknowledgedEventIds": acknowledged_event_ids
        }))
        .send()
        .await
        .map_err(|error| connection_error(&error))?;

    if response.status().as_u16() == 401 {
        return Err("HomePlace rejected this device credential. Pair the device again.".into());
    }
    ensure_success(&response, "heartbeat")?;
    let envelope: HeartbeatEnvelope = read_bounded_json(response).await?;
    validate_heartbeat(&envelope, profile)?;
    Ok(envelope)
}

fn deliver_notifications<F>(
    events: &[HeartbeatEvent],
    mut deliver: F,
) -> (Vec<String>, usize, usize)
where
    F: FnMut(&NotificationContent) -> Result<(), ()>,
{
    let mut acknowledged_event_ids = Vec::new();
    let mut delivered = 0;
    let mut failures = 0;

    for event in events {
        if event.kind != "notification.deliver" {
            continue;
        }

        let Ok(notification) = notification_content(event) else {
            failures += 1;
            continue;
        };

        if deliver(&notification).is_ok() {
            acknowledged_event_ids.push(event.id.clone());
            delivered += 1;
        } else {
            failures += 1;
        }
    }

    (acknowledged_event_ids, delivered, failures)
}

fn notification_content(event: &HeartbeatEvent) -> Result<NotificationContent, ()> {
    let mut content: NotificationContent =
        serde_json::from_value(event.payload.clone()).map_err(|_| ())?;
    content.title = bounded_notification_text(&content.title, 120)?;
    content.body = bounded_notification_text(&content.body, 1_000)?;
    Ok(content)
}

fn bounded_notification_text(value: &str, maximum: usize) -> Result<String, ()> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > maximum || value.chars().any(char::is_control) {
        return Err(());
    }
    Ok(value.to_owned())
}

#[tauri::command]
pub async fn disconnect_device(
    app: AppHandle,
    revoke: bool,
    service: State<'_, HeartbeatService>,
) -> Result<(), String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;

    if revoke {
        let credential = identity::load_credential(&profile.server_id)?;
        let (base_url, _) = validate_address(&profile.address)?;
        let endpoint = base_url
            .join("api/link/device")
            .map_err(|_| "Could not create the device API address.".to_string())?;
        let response = http_client()?
            .delete(endpoint)
            .bearer_auth(credential.as_str())
            .send()
            .await
            .map_err(|error| connection_error(&error))?;
        if response.status().as_u16() != 401 {
            ensure_success(&response, "device revocation")?;
        }
    }

    identity::delete_profile(&profile.server_id)?;
    crate::tray::refresh_menu(&app);
    service.wake();
    Ok(())
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "Could not initialise the secure connection.".to_string())
}

fn bounded_device_name(input: &str) -> Result<String, String> {
    let name = input.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("The device name must contain between 1 and 80 characters.".into());
    }
    Ok(name.into())
}

fn validate_pairing_response(envelope: &PairEnvelope) -> Result<(), String> {
    let pairing = &envelope.pairing;
    if envelope.protocol != PROTOCOL_MAX
        || !safe_identifier(&pairing.id)
        || pairing.code.len() != 6
        || !pairing.code.bytes().all(|byte| byte.is_ascii_digit())
        || !valid_secret(&pairing.claim_secret)
        || !(1..=30).contains(&pairing.poll_after_seconds)
    {
        return Err("The HomePlace server returned an invalid pairing session.".into());
    }

    let expiry = OffsetDateTime::parse(&pairing.expires_at, &Rfc3339)
        .map_err(|_| "The pairing session has an invalid expiry time.".to_string())?;
    let now = OffsetDateTime::now_utc();
    if expiry <= now || expiry - now > TimeDuration::minutes(15) {
        return Err("The pairing session expiry is outside the allowed range.".into());
    }
    Ok(())
}

fn valid_secret(value: &str) -> bool {
    (40..=80).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn validate_stored_profile(profile: &StoredProfile) -> Result<(), String> {
    if uuid::Uuid::parse_str(&profile.server_id).is_err()
        || !safe_identifier(&profile.device_id)
        || bounded_device_name(&profile.server_name).is_err()
        || bounded_device_name(&profile.device_name).is_err()
        || validate_address(&profile.address).is_err()
    {
        return Err("The stored HomePlace server profile is invalid.".into());
    }
    Ok(())
}

fn validate_heartbeat(envelope: &HeartbeatEnvelope, profile: &StoredProfile) -> Result<(), String> {
    if envelope.protocol != PROTOCOL_MAX
        || envelope.server_id != profile.server_id
        || envelope.events.len() > 50
    {
        return Err("The HomePlace server returned an invalid heartbeat.".into());
    }
    validate_server_time(&envelope.server_time)?;
    let mut event_ids = HashSet::with_capacity(envelope.events.len());
    for event in &envelope.events {
        if event.protocol != PROTOCOL_MAX
            || !safe_identifier(&event.id)
            || !event_ids.insert(event.id.as_str())
            || event.device_id != profile.device_id
            || event.kind.is_empty()
            || event.kind.len() > 80
            || OffsetDateTime::parse(&event.sent_at, &Rfc3339).is_err()
            || !event.payload.is_object()
        {
            return Err("The HomePlace server returned an invalid device event.".into());
        }
    }
    Ok(())
}

fn validate_server_time(value: &str) -> Result<(), String> {
    let server_time = OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| "The HomePlace server returned an invalid time.".to_string())?;
    if (OffsetDateTime::now_utc() - server_time)
        .whole_seconds()
        .abs()
        > 10 * 60
    {
        return Err("The server clock differs by more than 10 minutes.".into());
    }
    Ok(())
}

fn ensure_success(response: &Response, operation: &str) -> Result<(), String> {
    if response.status().is_redirection() {
        return Err(format!("The server redirected the {operation} request."));
    }
    if !response.status().is_success() {
        return Err(format!(
            "The {operation} request returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    Ok(())
}

async fn read_bounded_json<T: DeserializeOwned>(response: Response) -> Result<T, String> {
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

    serde_json::from_slice(&body)
        .map_err(|_| "The server returned an invalid Link API response.".to_string())
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
    fn validates_pairing_response_boundaries() {
        let envelope = PairEnvelope {
            protocol: PROTOCOL_MAX,
            pairing: PairingCreated {
                id: "pairing-id".into(),
                code: "123456".into(),
                claim_secret: "a".repeat(43),
                expires_at: (OffsetDateTime::now_utc() + TimeDuration::minutes(5))
                    .format(&Rfc3339)
                    .unwrap(),
                poll_after_seconds: 2,
            },
        };
        assert!(validate_pairing_response(&envelope).is_ok());

        let mut invalid_code = envelope;
        invalid_code.pairing.code = "12 456".into();
        assert!(validate_pairing_response(&invalid_code).is_err());
        assert!(!valid_secret("short"));
        assert!(!valid_secret(&"!".repeat(43)));
    }

    #[test]
    fn validates_bounded_device_names() {
        assert_eq!(bounded_device_name("  Studio Mac  ").unwrap(), "Studio Mac");
        assert!(bounded_device_name("").is_err());
        assert!(bounded_device_name(&"a".repeat(81)).is_err());
        assert!(bounded_device_name("Office\nMac").is_err());
        assert!(!safe_identifier("../pairing"));
    }

    #[test]
    fn validates_heartbeat_identity_and_events() {
        let profile = StoredProfile {
            server_id: "e54f9bfa-2543-4be2-bc07-c1eb3d0947ee".into(),
            server_name: "HomePlace".into(),
            address: "https://home.example.net".into(),
            device_id: "device_123".into(),
            device_name: "Studio Mac".into(),
        };
        let mut heartbeat = HeartbeatEnvelope {
            protocol: PROTOCOL_MAX,
            server_id: profile.server_id.clone(),
            server_time: OffsetDateTime::now_utc().format(&Rfc3339).unwrap(),
            events: vec![HeartbeatEvent {
                protocol: PROTOCOL_MAX,
                id: "event_123".into(),
                kind: "notification.deliver".into(),
                device_id: profile.device_id.clone(),
                sent_at: OffsetDateTime::now_utc().format(&Rfc3339).unwrap(),
                payload: serde_json::json!({ "title": "HomePlace" }),
            }],
        };

        assert!(validate_stored_profile(&profile).is_ok());
        assert!(validate_heartbeat(&heartbeat, &profile).is_ok());
        heartbeat.server_id = "e54f9bfa-2543-4be2-bc07-c1eb3d0947ef".into();
        assert!(validate_heartbeat(&heartbeat, &profile).is_err());
    }

    #[test]
    fn validates_notification_payload_boundaries() {
        let event = notification_event(serde_json::json!({
            "title": " HomePlace ",
            "body": " Connection restored "
        }));
        let content = notification_content(&event).unwrap();
        assert_eq!(content.title, "HomePlace");
        assert_eq!(content.body, "Connection restored");

        assert!(
            notification_content(&notification_event(serde_json::json!({
                "title": "HomePlace\nspoofed",
                "body": "Message"
            })))
            .is_err()
        );
        assert!(
            notification_content(&notification_event(serde_json::json!({
                "title": "HomePlace",
                "body": "x".repeat(1_001)
            })))
            .is_err()
        );
        assert!(
            notification_content(&notification_event(serde_json::json!({
                "title": "HomePlace",
                "body": "Message",
                "url": "https://example.net"
            })))
            .is_err()
        );
    }

    #[test]
    fn acknowledges_only_notifications_delivered_locally() {
        let events = vec![
            notification_event(serde_json::json!({
                "title": "HomePlace",
                "body": "Delivered"
            })),
            HeartbeatEvent {
                id: "unknown_event".into(),
                kind: "future.capability".into(),
                ..notification_event(serde_json::json!({}))
            },
        ];
        let (acknowledged, delivered, failures) = deliver_notifications(&events, |_| Ok(()));
        assert_eq!(acknowledged, vec!["notification_event"]);
        assert_eq!(delivered, 1);
        assert_eq!(failures, 0);

        let (acknowledged, delivered, failures) = deliver_notifications(&events[..1], |_| Err(()));
        assert!(acknowledged.is_empty());
        assert_eq!(delivered, 0);
        assert_eq!(failures, 1);
    }

    #[test]
    fn bounds_heartbeat_retry_backoff() {
        assert_eq!(heartbeat_retry_delay(1), Duration::from_secs(30));
        assert_eq!(heartbeat_retry_delay(2), Duration::from_secs(60));
        assert_eq!(heartbeat_retry_delay(3), Duration::from_secs(120));
        assert_eq!(heartbeat_retry_delay(4), Duration::from_secs(240));
        assert_eq!(heartbeat_retry_delay(5), Duration::from_secs(300));
        assert_eq!(heartbeat_retry_delay(u32::MAX), Duration::from_secs(300));
    }

    #[test]
    fn serializes_heartbeat_updates_for_the_interface() {
        let value = serde_json::to_value(HeartbeatUpdate::Connected {
            server_time: "2026-09-20T18:00:00Z".into(),
            pending_events: 2,
            delivered_notifications: 1,
            notification_failures: 0,
        })
        .unwrap();

        assert_eq!(value["status"], "connected");
        assert_eq!(value["serverTime"], "2026-09-20T18:00:00Z");
        assert_eq!(value["pendingEvents"], 2);
        assert_eq!(value["deliveredNotifications"], 1);
        assert_eq!(value["notificationFailures"], 0);
        assert!(value.get("server_time").is_none());
    }

    fn notification_event(payload: serde_json::Value) -> HeartbeatEvent {
        HeartbeatEvent {
            protocol: PROTOCOL_MAX,
            id: "notification_event".into(),
            kind: "notification.deliver".into(),
            device_id: "device_123".into(),
            sent_at: OffsetDateTime::now_utc().format(&Rfc3339).unwrap(),
            payload,
        }
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
