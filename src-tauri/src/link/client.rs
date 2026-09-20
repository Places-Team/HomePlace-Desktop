use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use reqwest::{Client, Response, redirect::Policy};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
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
const MAX_SHARE_FILE_BYTES: usize = 64 * 1024 * 1024;
const HEARTBEAT_EVENT: &str = "link-heartbeat";
const HEALTHY_HEARTBEAT_SECONDS: u64 = 30;
const MAX_RETRY_SECONDS: u64 = 5 * 60;
const CLIPBOARD_POLL_MILLISECONDS: u64 = 900;
const MAX_CLIPBOARD_HISTORY_ITEMS: usize = 50;

pub struct HeartbeatService {
    wake: mpsc::Sender<()>,
    offers: OfferStore,
    clipboard_hash: Arc<Mutex<Option<String>>>,
    clipboard_enabled: Arc<AtomicBool>,
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
pub struct ClipboardSyncStatus {
    enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardHistoryEntry {
    id: String,
    text: String,
    direction: String,
    created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareTarget {
    id: String,
    name: String,
    platform: String,
    supports_text: bool,
    supports_url: bool,
    supports_file: bool,
    online: bool,
    owner_name: String,
    owned_by_current_user: bool,
}

#[derive(Deserialize)]
struct ShareTargetsEnvelope {
    targets: Vec<ShareTarget>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderSummary {
    id: String,
    title: String,
    at: String,
    repeat: String,
}

#[derive(Deserialize)]
struct RemindersEnvelope {
    reminders: Vec<ReminderSummary>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventSummary {
    id: String,
    summary: String,
    start: String,
    end: String,
    all_day: bool,
    location: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSummary {
    status: String,
    events: Vec<CalendarEventSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarMutationInput {
    summary: String,
    start: String,
    end: String,
    all_day: bool,
    location: Option<String>,
    from: String,
    to: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatStatus {
    server_time: String,
    pending_events: usize,
    delivered_notifications: usize,
    notification_failures: usize,
    offers: Vec<ShareOfferSummary>,
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
        offers: Vec<ShareOfferSummary>,
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareOfferSummary {
    id: String,
    kind: String,
    source_name: String,
    sent_at: String,
    filename: Option<String>,
    size: Option<usize>,
}

#[derive(Clone, Debug)]
struct PendingShareOffer {
    id: String,
    server_id: String,
    source_name: String,
    sent_at: String,
    content: ShareContent,
}

#[derive(Clone, Debug)]
enum ShareContent {
    Url(String),
    Text(String),
    File(FileOffer),
}

#[derive(Clone, Debug)]
struct FileOffer {
    transfer_id: String,
    filename: String,
    mime_type: String,
    size: usize,
    sha256: String,
}

type OfferStore = Arc<Mutex<HashMap<String, PendingShareOffer>>>;

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
        permissions: vec![
            "calendar.read",
            "calendar.manage",
            "reminder.manage",
            "share.relay",
        ],
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
    let clipboard_enabled = identity::clipboard_sync_enabled(&profile.server_id)?;
    service
        .clipboard_enabled
        .store(clipboard_enabled, Ordering::Relaxed);
    let current = app.clipboard().read_text().unwrap_or_default();
    *service
        .clipboard_hash
        .lock()
        .map_err(|_| "Could not update clipboard synchronisation state.".to_string())? =
        Some(clipboard_digest(&current));
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

async fn send_heartbeat(
    app: &AppHandle,
    offers: &OfferStore,
    clipboard_hash: &Arc<Mutex<Option<String>>>,
    clipboard_enabled: bool,
) -> Result<HeartbeatStatus, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;

    let envelope = heartbeat_request(&profile, credential.as_str(), &[]).await?;
    let mut clipboard_event_ids =
        deliver_clipboard_updates(&envelope.events, clipboard_enabled, |text| {
            app.clipboard().write_text(text).map_err(|_| ())?;
            record_clipboard_history(app, text, "received").map_err(|_| ())?;
            let mut current = clipboard_hash.lock().map_err(|_| ())?;
            *current = Some(clipboard_digest(text));
            Ok(())
        });
    let (mut acknowledged_event_ids, delivered_notifications, notification_failures) =
        deliver_notifications(&envelope.events, |notification| {
            app.notification()
                .builder()
                .title(&notification.title)
                .body(&notification.body)
                .show()
                .map_err(|_| ())
        });
    acknowledged_event_ids.append(&mut clipboard_event_ids);

    let envelope = if acknowledged_event_ids.is_empty() {
        envelope
    } else {
        heartbeat_request(&profile, credential.as_str(), &acknowledged_event_ids).await?
    };
    let share_offers = sync_share_offers(app, offers, &profile, &envelope.events)?;

    Ok(HeartbeatStatus {
        server_time: envelope.server_time,
        pending_events: envelope.events.len(),
        delivered_notifications,
        notification_failures,
        offers: share_offers,
    })
}

pub fn start_heartbeat_service(app: AppHandle) -> HeartbeatService {
    let (wake, mut wake_requests) = mpsc::channel(1);
    let offers = Arc::new(Mutex::new(HashMap::new()));
    let clipboard_hash = Arc::new(Mutex::new(None));
    let initial_clipboard_enabled = identity::load_profile()
        .ok()
        .flatten()
        .and_then(|profile| identity::clipboard_sync_enabled(&profile.server_id).ok())
        .unwrap_or(false);
    let clipboard_enabled = Arc::new(AtomicBool::new(initial_clipboard_enabled));
    let worker_offers = Arc::clone(&offers);
    let worker_clipboard_hash = Arc::clone(&clipboard_hash);
    let worker_clipboard_enabled = Arc::clone(&clipboard_enabled);
    let clipboard_app = app.clone();
    let polling_clipboard_hash = Arc::clone(&clipboard_hash);
    let polling_clipboard_enabled = Arc::clone(&clipboard_enabled);
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

                let result = send_heartbeat(
                    &app,
                    &worker_offers,
                    &worker_clipboard_hash,
                    worker_clipboard_enabled.load(Ordering::Relaxed),
                )
                .await;
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
                                offers: status.offers,
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
    tauri::async_runtime::spawn(async move {
        let mut context: Option<(String, bool)> = None;
        loop {
            sleep(Duration::from_millis(CLIPBOARD_POLL_MILLISECONDS)).await;
            let Some(profile) = identity::load_profile().ok().flatten() else {
                context = None;
                polling_clipboard_enabled.store(false, Ordering::Relaxed);
                continue;
            };
            let enabled = polling_clipboard_enabled.load(Ordering::Relaxed);
            let next_context = (profile.server_id.clone(), enabled);
            if context.as_ref() != Some(&next_context) {
                if let Ok(text) = clipboard_app.clipboard().read_text()
                    && let Ok(mut current) = polling_clipboard_hash.lock()
                {
                    *current = Some(clipboard_digest(&text));
                }
                context = Some(next_context);
                continue;
            }
            if !enabled {
                continue;
            }
            let Ok(text) = clipboard_app.clipboard().read_text() else {
                continue;
            };
            if !valid_clipboard_text(&text) {
                continue;
            }
            let digest = clipboard_digest(&text);
            let changed = if let Ok(mut current) = polling_clipboard_hash.lock() {
                if current.as_deref() == Some(digest.as_str()) {
                    false
                } else {
                    *current = Some(digest);
                    true
                }
            } else {
                false
            };
            if !changed {
                continue;
            }
            let Ok(credential) = identity::load_credential(&profile.server_id) else {
                continue;
            };
            if relay_clipboard_update(&profile, credential.as_str(), &text)
                .await
                .is_ok()
            {
                let _ = record_clipboard_history(&clipboard_app, &text, "sent");
            }
        }
    });
    HeartbeatService {
        wake,
        offers,
        clipboard_hash,
        clipboard_enabled,
    }
}

#[tauri::command]
pub fn request_heartbeat(service: State<'_, HeartbeatService>) {
    service.wake();
}

#[tauri::command]
pub fn clipboard_sync_status() -> Result<ClipboardSyncStatus, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    Ok(ClipboardSyncStatus {
        enabled: identity::clipboard_sync_enabled(&profile.server_id)?,
    })
}

#[tauri::command]
pub fn clipboard_history(app: AppHandle) -> Result<Vec<ClipboardHistoryEntry>, String> {
    load_clipboard_history(&app)
}

#[tauri::command]
pub fn clear_clipboard_history(app: AppHandle) -> Result<(), String> {
    let path = clipboard_history_path(&app)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not clear clipboard history.".to_string()),
    }
}

#[tauri::command]
pub async fn list_share_targets() -> Result<Vec<ShareTarget>, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/mobile/share")
        .map_err(|_| "Could not create the sharing API address.".to_string())?;
    let response = http_client()?
        .get(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    match response.status().as_u16() {
        401 => {
            return Err("HomePlace rejected the device credential. Pair this device again.".into());
        }
        403 => {
            return Err(
                "Sharing was not approved for this device. Pair it again and approve sharing."
                    .into(),
            );
        }
        _ => ensure_success(&response, "share target list")?,
    }
    let envelope: ShareTargetsEnvelope = read_bounded_json(response).await?;
    if envelope.targets.len() > 100
        || envelope.targets.iter().any(|target| {
            !safe_identifier(&target.id)
                || bounded_device_name(&target.name).is_err()
                || bounded_device_name(&target.owner_name).is_err()
                || target.platform.len() > 24
        })
    {
        return Err("HomePlace returned an invalid device list.".into());
    }
    Ok(envelope.targets)
}

#[tauri::command]
pub async fn send_share_text(
    target_device_id: String,
    kind: String,
    value: String,
) -> Result<(), String> {
    if !safe_identifier(&target_device_id) {
        return Err("The target device is invalid.".into());
    }
    let value = match kind.as_str() {
        "text" => valid_offer_text(&value),
        "url" => valid_offer_url(&value),
        _ => None,
    }
    .ok_or_else(|| "The shared text or link is invalid.".to_string())?;
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/mobile/share")
        .map_err(|_| "Could not create the sharing API address.".to_string())?;
    let response = http_client()?
        .post(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .json(&serde_json::json!({
            "targetDeviceId": target_device_id,
            "type": kind,
            "value": value,
        }))
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    match response.status().as_u16() {
        401 => Err("HomePlace rejected the device credential. Pair this device again.".into()),
        403 => Err(
            "Sharing was not approved for this device. Pair it again and approve sharing.".into(),
        ),
        404 => Err("The selected device is no longer available.".into()),
        _ => ensure_success(&response, "content share"),
    }
}

#[tauri::command]
pub async fn send_share_file(target_device_id: String, file_path: String) -> Result<(), String> {
    if !safe_identifier(&target_device_id) {
        return Err("The target device is invalid.".into());
    }
    let path = PathBuf::from(file_path);
    let metadata =
        fs::metadata(&path).map_err(|_| "The dropped file is no longer available.".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_SHARE_FILE_BYTES as u64 {
        return Err("Choose a file between 1 byte and 64 MiB.".into());
    }
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| {
            !name.is_empty() && name.chars().count() <= 240 && !name.chars().any(char::is_control)
        })
        .ok_or_else(|| "The dropped filename is invalid.".to_string())?
        .to_owned();
    let read_path = path.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || fs::read(read_path))
        .await
        .map_err(|_| "The dropped file could not be read.".to_string())?
        .map_err(|_| "The dropped file could not be read.".to_string())?;
    if bytes.len() != metadata.len() as usize {
        return Err("The dropped file changed while it was being read.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/mobile/share/file")
        .map_err(|_| "Could not create the file sharing API address.".to_string())?;
    let response = http_client()?
        .post(endpoint)
        .header("Accept", "application/json")
        .header("Content-Type", "application/octet-stream")
        .header("x-homeplace-target", target_device_id)
        .header(
            "x-homeplace-filename-base64",
            STANDARD.encode(filename.as_bytes()),
        )
        .bearer_auth(credential.as_str())
        .body(bytes)
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    match response.status().as_u16() {
        401 => Err("HomePlace rejected the device credential. Pair this device again.".into()),
        403 => Err(
            "Sharing was not approved for this device. Pair it again and approve sharing.".into(),
        ),
        404 => Err("The selected device is no longer available.".into()),
        413 => Err("The selected file is larger than 64 MiB.".into()),
        _ => ensure_success(&response, "file share"),
    }
}

#[tauri::command]
pub fn set_clipboard_sync(
    app: AppHandle,
    enabled: bool,
    service: State<'_, HeartbeatService>,
) -> Result<ClipboardSyncStatus, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    identity::store_clipboard_sync(&profile.server_id, enabled)?;
    service.clipboard_enabled.store(enabled, Ordering::Relaxed);
    let current = app.clipboard().read_text().unwrap_or_default();
    *service
        .clipboard_hash
        .lock()
        .map_err(|_| "Could not update clipboard synchronisation state.".to_string())? =
        Some(clipboard_digest(&current));
    service.wake();
    Ok(ClipboardSyncStatus { enabled })
}

fn deliver_clipboard_updates<F>(
    events: &[HeartbeatEvent],
    enabled: bool,
    mut write: F,
) -> Vec<String>
where
    F: FnMut(&str) -> Result<(), ()>,
{
    if !enabled {
        return Vec::new();
    }
    events
        .iter()
        .filter_map(|event| {
            if event.kind != "clipboard.offer" {
                return None;
            }
            let text = event.payload.get("text")?.as_str()?;
            if !valid_clipboard_text(text) || write(text).is_err() {
                return None;
            }
            Some(event.id.clone())
        })
        .collect()
}

fn valid_clipboard_text(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= 8_000
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

fn clipboard_digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn clipboard_history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not locate HomePlace application data.".to_string())?;
    fs::create_dir_all(&directory)
        .map_err(|_| "Could not prepare clipboard history storage.".to_string())?;
    Ok(directory.join("clipboard-history.json"))
}

fn load_clipboard_history(app: &AppHandle) -> Result<Vec<ClipboardHistoryEntry>, String> {
    let path = clipboard_history_path(app)?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Could not read clipboard history.".to_string()),
    };
    let mut entries: Vec<ClipboardHistoryEntry> = serde_json::from_slice(&bytes)
        .map_err(|_| "The clipboard history is invalid.".to_string())?;
    entries.truncate(MAX_CLIPBOARD_HISTORY_ITEMS);
    Ok(entries)
}

fn record_clipboard_history(app: &AppHandle, text: &str, direction: &str) -> Result<(), String> {
    if !valid_clipboard_text(text) {
        return Ok(());
    }
    let digest = clipboard_digest(text);
    let now = OffsetDateTime::now_utc();
    let created_at = now
        .format(&Rfc3339)
        .map_err(|_| "Could not timestamp clipboard history.".to_string())?;
    let mut entries = load_clipboard_history(app)?;
    entries.retain(|entry| clipboard_digest(&entry.text) != digest);
    entries.insert(
        0,
        ClipboardHistoryEntry {
            id: format!("{}-{}", now.unix_timestamp_nanos(), &digest[..12]),
            text: text.to_owned(),
            direction: direction.to_owned(),
            created_at,
        },
    );
    entries.truncate(MAX_CLIPBOARD_HISTORY_ITEMS);
    let encoded = serde_json::to_vec(&entries)
        .map_err(|_| "Could not encode clipboard history.".to_string())?;
    fs::write(clipboard_history_path(app)?, encoded)
        .map_err(|_| "Could not save clipboard history.".to_string())
}

async fn relay_clipboard_update(
    profile: &StoredProfile,
    credential: &str,
    text: &str,
) -> Result<(), String> {
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/clipboard")
        .map_err(|_| "Could not create the clipboard relay address.".to_string())?;
    let response = http_client()?
        .post(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential)
        .json(&serde_json::json!({ "text": text }))
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    ensure_success(&response, "clipboard relay")
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
            "capabilities": initial_capabilities(),
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

fn sync_share_offers(
    app: &AppHandle,
    offers: &OfferStore,
    profile: &StoredProfile,
    events: &[HeartbeatEvent],
) -> Result<Vec<ShareOfferSummary>, String> {
    let parsed: Vec<PendingShareOffer> = events
        .iter()
        .filter_map(|event| pending_share_offer(event, &profile.server_id))
        .collect();
    let active_ids: HashSet<&str> = parsed.iter().map(|offer| offer.id.as_str()).collect();
    let mut new_offers = Vec::new();
    {
        let mut stored = offers
            .lock()
            .map_err(|_| "Could not access pending HomePlace offers.".to_string())?;
        stored.retain(|_, offer| {
            offer.server_id != profile.server_id || active_ids.contains(offer.id.as_str())
        });
        for offer in parsed {
            let key = offer_key(&offer.server_id, &offer.id);
            if !stored.contains_key(&key) {
                new_offers.push(offer.clone());
            }
            stored.insert(key, offer);
        }
    }

    for offer in new_offers {
        let kind = match offer.content {
            ShareContent::Url(_) => "link",
            ShareContent::Text(_) => "text",
            ShareContent::File(_) => "file",
        };
        let _ = app
            .notification()
            .builder()
            .title("HomePlace Link")
            .body(format!(
                "New {kind} from {} is waiting for approval.",
                offer.source_name
            ))
            .show();
    }

    offer_summaries(offers, &profile.server_id)
}

fn pending_share_offer(event: &HeartbeatEvent, server_id: &str) -> Option<PendingShareOffer> {
    let source_name =
        bounded_notification_text(event.payload.get("sourceName")?.as_str()?, 80).ok()?;
    let content = match event.kind.as_str() {
        "clipboard.offer" => {
            ShareContent::Text(valid_offer_text(event.payload.get("text")?.as_str()?)?)
        }
        "share.offer" => match event.payload.get("type")?.as_str()? {
            "url" => ShareContent::Url(valid_offer_url(event.payload.get("value")?.as_str()?)?),
            "text" => ShareContent::Text(valid_offer_text(event.payload.get("value")?.as_str()?)?),
            "file" => ShareContent::File(valid_file_offer(&event.payload)?),
            _ => return None,
        },
        _ => return None,
    };
    Some(PendingShareOffer {
        id: event.id.clone(),
        server_id: server_id.to_owned(),
        source_name,
        sent_at: event.sent_at.clone(),
        content,
    })
}

fn valid_offer_text(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > 8_000
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return None;
    }
    Some(value.to_owned())
}

fn valid_offer_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 4_096 {
        return None;
    }
    let url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url.to_string())
}

fn valid_file_offer(payload: &serde_json::Value) -> Option<FileOffer> {
    let transfer_id = payload.get("transferId")?.as_str()?;
    if !safe_identifier(transfer_id) {
        return None;
    }
    let filename = payload.get("filename")?.as_str()?.trim();
    if filename.is_empty()
        || filename.chars().count() > 180
        || filename == "."
        || filename == ".."
        || filename
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
    {
        return None;
    }
    let mime_type = payload.get("mimeType")?.as_str()?.trim();
    if mime_type.is_empty()
        || mime_type.chars().count() > 120
        || mime_type.chars().any(char::is_control)
    {
        return None;
    }
    let size = usize::try_from(payload.get("size")?.as_u64()?).ok()?;
    if size == 0 || size > MAX_SHARE_FILE_BYTES {
        return None;
    }
    let sha256 = payload.get("sha256")?.as_str()?;
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    Some(FileOffer {
        transfer_id: transfer_id.to_owned(),
        filename: filename.to_owned(),
        mime_type: mime_type.to_owned(),
        size,
        sha256: sha256.to_owned(),
    })
}

fn offer_key(server_id: &str, event_id: &str) -> String {
    format!("{server_id}:{event_id}")
}

fn offer_summaries(offers: &OfferStore, server_id: &str) -> Result<Vec<ShareOfferSummary>, String> {
    let stored = offers
        .lock()
        .map_err(|_| "Could not access pending HomePlace offers.".to_string())?;
    let mut summaries: Vec<ShareOfferSummary> = stored
        .values()
        .filter(|offer| offer.server_id == server_id)
        .map(|offer| ShareOfferSummary {
            id: offer.id.clone(),
            kind: match offer.content {
                ShareContent::Url(_) => "url".into(),
                ShareContent::Text(_) => "text".into(),
                ShareContent::File(_) => "file".into(),
            },
            source_name: offer.source_name.clone(),
            sent_at: offer.sent_at.clone(),
            filename: match &offer.content {
                ShareContent::File(file) => Some(file.filename.clone()),
                _ => None,
            },
            size: match &offer.content {
                ShareContent::File(file) => Some(file.size),
                _ => None,
            },
        })
        .collect();
    summaries.sort_by(|left, right| left.sent_at.cmp(&right.sent_at));
    Ok(summaries)
}

#[tauri::command]
pub async fn resolve_share_offer(
    app: AppHandle,
    event_id: String,
    action: String,
    service: State<'_, HeartbeatService>,
) -> Result<Vec<ShareOfferSummary>, String> {
    if !safe_identifier(&event_id) {
        return Err("The HomePlace offer ID is invalid.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let key = offer_key(&profile.server_id, &event_id);
    let offer = service
        .offers
        .lock()
        .map_err(|_| "Could not access pending HomePlace offers.".to_string())?
        .get(&key)
        .cloned()
        .ok_or_else(|| "The HomePlace offer is no longer available.".to_string())?;
    let credential = identity::load_credential(&profile.server_id)?;

    match (action.as_str(), &offer.content) {
        ("open", ShareContent::Url(url)) => app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "The link could not be opened.".to_string())?,
        ("copy", ShareContent::Text(text)) => app
            .clipboard()
            .write_text(text)
            .map_err(|_| "The text could not be copied to clipboard.".to_string())?,
        ("save", ShareContent::File(file)) => {
            if !save_received_file(&app, &profile, credential.as_str(), file).await? {
                return offer_summaries(&service.offers, &profile.server_id);
            }
        }
        ("decline", _) => {}
        _ => return Err("The requested HomePlace offer action is not allowed.".into()),
    }

    heartbeat_request(&profile, credential.as_str(), &[event_id]).await?;
    service
        .offers
        .lock()
        .map_err(|_| "Could not access pending HomePlace offers.".to_string())?
        .remove(&key);
    service.wake();
    offer_summaries(&service.offers, &profile.server_id)
}

async fn save_received_file(
    app: &AppHandle,
    profile: &StoredProfile,
    credential: &str,
    offer: &FileOffer,
) -> Result<bool, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .set_file_name(&offer.filename)
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let destination = selected
        .as_path()
        .ok_or_else(|| "Only local file destinations are supported.".to_string())?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join(&format!("api/link/mobile/share/file/{}", offer.transfer_id))
        .map_err(|_| "Could not create the HomePlace file address.".to_string())?;
    let response = http_client()?
        .get(endpoint)
        .header("Accept", "application/octet-stream")
        .bearer_auth(credential)
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    if response.status().as_u16() == 401 {
        return Err("HomePlace rejected this device credential. Pair the device again.".into());
    }
    ensure_success(&response, "file download")?;
    if response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some(offer.mime_type.as_str())
    {
        return Err("The received file type does not match the offer.".into());
    }
    if response
        .content_length()
        .is_some_and(|length| length != offer.size as u64)
    {
        return Err("The received file size does not match the offer.".into());
    }
    if response
        .headers()
        .get("x-homeplace-sha256")
        .and_then(|value| value.to_str().ok())
        != Some(offer.sha256.as_str())
    {
        return Err("The received file checksum header does not match the offer.".into());
    }

    let mut bytes = Vec::with_capacity(offer.size);
    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The shared file could not be downloaded.".to_string())?;
        if bytes.len().saturating_add(chunk.len()) > offer.size
            || bytes.len().saturating_add(chunk.len()) > MAX_SHARE_FILE_BYTES
        {
            return Err("The shared file is larger than the approved offer.".into());
        }
        hasher.update(&chunk);
        bytes.extend_from_slice(&chunk);
    }
    let actual_sha256 = format!("{:x}", hasher.finalize());
    if !file_integrity_matches(offer.size, &offer.sha256, bytes.len(), &actual_sha256) {
        return Err("The shared file failed its integrity check.".into());
    }

    write_verified_file(destination, &bytes)?;
    Ok(true)
}

fn file_integrity_matches(
    expected_size: usize,
    expected_sha256: &str,
    actual_size: usize,
    actual_sha256: &str,
) -> bool {
    actual_size == expected_size && actual_sha256 == expected_sha256
}

fn write_verified_file(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "The selected file destination is invalid.".to_string())?;
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "The selected file name is invalid.".to_string())?;
    let temporary = parent.join(format!(
        ".{file_name}.homeplace-{}.part",
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| {
                "Could not create a temporary file at the selected destination.".to_string()
            })?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not safely write the shared file.".to_string())?;
        drop(file);
        #[cfg(target_os = "windows")]
        if destination.exists() {
            fs::remove_file(destination)
                .map_err(|_| "Could not replace the selected Windows file.".to_string())?;
        }
        fs::rename(&temporary, destination).map_err(|_| {
            "Could not move the shared file into its selected destination.".to_string()
        })?;
        #[cfg(unix)]
        if let Ok(directory) = fs::File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
pub async fn list_reminders() -> Result<Vec<ReminderSummary>, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    let credential = identity::load_credential(&profile.server_id)?;
    fetch_reminders(&profile, credential.as_str()).await
}

#[tauri::command]
pub async fn list_calendar_events(from: String, to: String) -> Result<CalendarSummary, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    let credential = identity::load_credential(&profile.server_id)?;
    fetch_calendar_events(&profile, credential.as_str(), &from, &to).await
}

async fn fetch_calendar_events(
    profile: &StoredProfile,
    credential: &str,
    from: &str,
    to: &str,
) -> Result<CalendarSummary, String> {
    validate_calendar_range(from, to)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let mut endpoint = base_url
        .join("api/link/calendar")
        .map_err(|_| "Could not create calendar API address.".to_string())?;
    endpoint
        .query_pairs_mut()
        .append_pair("from", from)
        .append_pair("to", to);
    let response = http_client()?
        .get(endpoint)
        .bearer_auth(credential)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| connection_error(&error))?;

    match response.status().as_u16() {
        401 => return Err("HomePlace rejected the device credential. Pair this device again.".into()),
        403 => return Err("Calendar access was not approved for this device. Pair it again and approve the requested permission.".into()),
        _ => ensure_success(&response, "calendar")?,
    }
    let envelope: CalendarSummary = read_bounded_json(response).await?;
    if !matches!(
        envelope.status.as_str(),
        "connected" | "not_connected" | "unavailable"
    ) {
        return Err("The HomePlace server returned an invalid calendar status.".into());
    }
    Ok(CalendarSummary {
        status: envelope.status,
        events: validate_calendar_events(envelope.events)?,
    })
}

#[tauri::command]
pub async fn create_calendar_event(
    input: CalendarMutationInput,
) -> Result<CalendarSummary, String> {
    mutate_calendar_event(None, input).await
}

#[tauri::command]
pub async fn update_calendar_event(
    id: String,
    input: CalendarMutationInput,
) -> Result<CalendarSummary, String> {
    if !safe_calendar_identifier(&id) {
        return Err("The calendar event identifier is invalid.".into());
    }
    mutate_calendar_event(Some(id), input).await
}

#[tauri::command]
pub async fn delete_calendar_event(
    id: String,
    from: String,
    to: String,
) -> Result<CalendarSummary, String> {
    if !safe_calendar_identifier(&id) {
        return Err("The calendar event identifier is invalid.".into());
    }
    mutate_calendar_request(
        serde_json::json!({ "action": "delete", "id": id }),
        from,
        to,
    )
    .await
}

async fn mutate_calendar_event(
    id: Option<String>,
    input: CalendarMutationInput,
) -> Result<CalendarSummary, String> {
    let summary = input.summary.trim().to_owned();
    let location = input
        .location
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let start_time = validate_calendar_time(&input.start, input.all_day)?;
    let end_time = validate_calendar_time(&input.end, input.all_day)?;
    if summary.is_empty()
        || !safe_calendar_text(&summary, 300)
        || location
            .as_deref()
            .is_some_and(|value| !safe_calendar_text(value, 300))
        || end_time <= start_time
    {
        return Err("The calendar event details are invalid.".into());
    }
    mutate_calendar_request(
        serde_json::json!({
            "action": if id.is_some() { "update" } else { "create" },
            "id": id,
            "summary": summary,
            "start": input.start,
            "end": input.end,
            "allDay": input.all_day,
            "location": location,
        }),
        input.from,
        input.to,
    )
    .await
}

async fn mutate_calendar_request(
    body: serde_json::Value,
    from: String,
    to: String,
) -> Result<CalendarSummary, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/calendar")
        .map_err(|_| "Could not create calendar API address.".to_string())?;
    let response = http_client()?
        .post(endpoint)
        .bearer_auth(credential.as_str())
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    match response.status().as_u16() {
        401 => return Err("HomePlace rejected the device credential. Pair this device again.".into()),
        403 => return Err("Calendar changes were not approved for this device. Pair it again and approve the requested permission.".into()),
        _ => ensure_success(&response, "calendar change")?,
    }
    fetch_calendar_events(&profile, credential.as_str(), &from, &to).await
}

#[tauri::command]
pub async fn create_reminder(
    title: String,
    at: String,
    repeat: String,
) -> Result<Vec<ReminderSummary>, String> {
    let title = validate_reminder_title(&title)?;
    validate_reminder_time(&at)?;
    validate_reminder_repeat(&repeat)?;
    mutate_reminders(serde_json::json!({
        "action": "create",
        "title": title,
        "at": at,
        "repeat": repeat,
    }))
    .await
}

#[tauri::command]
pub async fn update_reminder(
    id: String,
    title: String,
    at: String,
    repeat: String,
) -> Result<Vec<ReminderSummary>, String> {
    if !safe_identifier(&id) {
        return Err("The reminder identifier is invalid.".into());
    }
    let title = validate_reminder_title(&title)?;
    validate_reminder_time(&at)?;
    validate_reminder_repeat(&repeat)?;
    mutate_reminders(serde_json::json!({
        "action": "update",
        "id": id,
        "title": title,
        "at": at,
        "repeat": repeat,
    }))
    .await
}

#[tauri::command]
pub async fn complete_reminder(id: String) -> Result<Vec<ReminderSummary>, String> {
    mutate_reminder_by_id("complete", id).await
}

#[tauri::command]
pub async fn delete_reminder(id: String) -> Result<Vec<ReminderSummary>, String> {
    mutate_reminder_by_id("delete", id).await
}

async fn mutate_reminder_by_id(
    action: &'static str,
    id: String,
) -> Result<Vec<ReminderSummary>, String> {
    if !safe_identifier(&id) {
        return Err("The reminder identifier is invalid.".into());
    }
    mutate_reminders(serde_json::json!({ "action": action, "id": id })).await
}

async fn mutate_reminders(body: serde_json::Value) -> Result<Vec<ReminderSummary>, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/reminders")
        .map_err(|_| "Could not create reminders API address.".to_string())?;
    let response = http_client()?
        .post(endpoint)
        .bearer_auth(credential.as_str())
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    ensure_reminder_access(&response)?;
    ensure_success(&response, "reminder")?;
    fetch_reminders(&profile, credential.as_str()).await
}

async fn fetch_reminders(
    profile: &StoredProfile,
    credential: &str,
) -> Result<Vec<ReminderSummary>, String> {
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/reminders")
        .map_err(|_| "Could not create reminders API address.".to_string())?;
    let response = http_client()?
        .get(endpoint)
        .bearer_auth(credential)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    ensure_reminder_access(&response)?;
    ensure_success(&response, "reminders")?;
    let envelope: RemindersEnvelope = read_bounded_json(response).await?;
    validate_reminders(envelope.reminders)
}

fn ensure_reminder_access(response: &Response) -> Result<(), String> {
    match response.status().as_u16() {
        401 => Err("HomePlace rejected this device credential. Pair the device again.".into()),
        403 => Err("Reminder access was not approved for this device. Pair it again and approve the requested permission.".into()),
        _ => Ok(()),
    }
}

fn validate_reminders(reminders: Vec<ReminderSummary>) -> Result<Vec<ReminderSummary>, String> {
    if reminders.len() > 100 {
        return Err("The HomePlace server returned too many reminders.".into());
    }
    for reminder in &reminders {
        if !safe_identifier(&reminder.id)
            || validate_reminder_title(&reminder.title).is_err()
            || validate_reminder_time(&reminder.at).is_err()
            || validate_reminder_repeat(&reminder.repeat).is_err()
        {
            return Err("The HomePlace server returned an invalid reminder.".into());
        }
    }
    Ok(reminders)
}

fn validate_calendar_events(
    events: Vec<CalendarEventSummary>,
) -> Result<Vec<CalendarEventSummary>, String> {
    if events.len() > 250 {
        return Err("The HomePlace server returned too many calendar events.".into());
    }
    for event in &events {
        let start = validate_calendar_time(&event.start, event.all_day)?;
        let end = validate_calendar_time(&event.end, event.all_day)?;
        if !safe_calendar_identifier(&event.id)
            || !safe_calendar_text(&event.summary, 300)
            || event
                .location
                .as_deref()
                .is_some_and(|value| !safe_calendar_text(value, 300))
            || end < start
        {
            return Err("The HomePlace server returned an invalid calendar event.".into());
        }
    }
    Ok(events)
}

fn validate_calendar_time(value: &str, all_day: bool) -> Result<OffsetDateTime, String> {
    let normalized = if all_day {
        if value.len() != 10
            || !value.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 4 | 7) {
                    byte == b'-'
                } else {
                    byte.is_ascii_digit()
                }
            })
        {
            return Err("The HomePlace server returned an invalid calendar date.".into());
        }
        format!("{value}T00:00:00Z")
    } else {
        value.to_owned()
    };
    OffsetDateTime::parse(&normalized, &Rfc3339)
        .map_err(|_| "The HomePlace server returned an invalid calendar date.".to_string())
}

fn validate_calendar_range(from: &str, to: &str) -> Result<(), String> {
    let from = OffsetDateTime::parse(from, &Rfc3339)
        .map_err(|_| "The calendar range is invalid.".to_string())?;
    let to = OffsetDateTime::parse(to, &Rfc3339)
        .map_err(|_| "The calendar range is invalid.".to_string())?;
    if to <= from || to - from > TimeDuration::days(93) {
        return Err("The calendar range is invalid.".into());
    }
    Ok(())
}

fn safe_calendar_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn safe_calendar_text(value: &str, maximum: usize) -> bool {
    value.chars().count() <= maximum && !value.chars().any(char::is_control)
}

fn validate_reminder_title(value: &str) -> Result<String, String> {
    let title = value.trim();
    if title.is_empty()
        || title.chars().count() > 200
        || title.chars().any(|character| character.is_control())
    {
        return Err("Reminder title must be between 1 and 200 characters.".into());
    }
    Ok(title.to_owned())
}

fn validate_reminder_time(value: &str) -> Result<(), String> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map(|_| ())
        .map_err(|_| "The reminder time is invalid.".to_string())
}

fn validate_reminder_repeat(value: &str) -> Result<(), String> {
    if matches!(
        value,
        "none" | "hourly" | "daily" | "weekly" | "monthly" | "yearly"
    ) || parse_custom_repeat(value)
    {
        Ok(())
    } else {
        Err("The reminder repeat schedule is invalid.".into())
    }
}

fn parse_custom_repeat(value: &str) -> bool {
    let mut parts = value.split(':');
    let Some("every") = parts.next() else {
        return false;
    };
    let Some(count) = parts.next().and_then(|item| item.parse::<u16>().ok()) else {
        return false;
    };
    let Some(unit) = parts.next() else {
        return false;
    };
    parts.next().is_none()
        && (2..=999).contains(&count)
        && matches!(unit, "hour" | "day" | "week" | "month" | "year")
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
    let clipboard_enabled = identity::load_profile()?
        .and_then(|next| identity::clipboard_sync_enabled(&next.server_id).ok())
        .unwrap_or(false);
    service
        .clipboard_enabled
        .store(clipboard_enabled, Ordering::Relaxed);
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
    fn seamless_clipboard_acknowledges_only_successful_exact_writes() {
        let event = share_event(
            "clipboard.offer",
            serde_json::json!({ "text": "  copied text\n", "sourceName": "Phone" }),
        );
        let mut written = String::new();
        let acknowledged = deliver_clipboard_updates(&[event], true, |text| {
            written = text.to_owned();
            Ok(())
        });
        assert_eq!(written, "  copied text\n");
        assert_eq!(acknowledged, vec!["offer_123"]);
        assert!(deliver_clipboard_updates(&[], false, |_| Ok(())).is_empty());
    }

    #[test]
    fn clipboard_hash_suppresses_round_trips() {
        assert_eq!(clipboard_digest("same"), clipboard_digest("same"));
        assert_ne!(clipboard_digest("same"), clipboard_digest("different"));
        assert!(valid_clipboard_text("line one\nline two"));
        assert!(!valid_clipboard_text("secret\0text"));
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
            offers: vec![ShareOfferSummary {
                id: "offer_123".into(),
                kind: "url".into(),
                source_name: "Phone".into(),
                sent_at: "2026-09-20T17:59:00Z".into(),
                filename: None,
                size: None,
            }],
        })
        .unwrap();

        assert_eq!(value["status"], "connected");
        assert_eq!(value["serverTime"], "2026-09-20T18:00:00Z");
        assert_eq!(value["pendingEvents"], 2);
        assert_eq!(value["deliveredNotifications"], 1);
        assert_eq!(value["notificationFailures"], 0);
        assert_eq!(value["offers"][0]["kind"], "url");
        assert!(value.get("server_time").is_none());
    }

    #[test]
    fn validates_share_offers_without_exposing_their_content() {
        let event = share_event(
            "share.offer",
            serde_json::json!({
                "type": "url",
                "value": "https://example.net/watch?id=1",
                "sourceName": "Phone"
            }),
        );
        let offer = pending_share_offer(&event, "e54f9bfa-2543-4be2-bc07-c1eb3d0947ee").unwrap();

        assert!(matches!(offer.content, ShareContent::Url(_)));
        let summary = ShareOfferSummary {
            id: offer.id,
            kind: "url".into(),
            source_name: offer.source_name,
            sent_at: offer.sent_at,
            filename: None,
            size: None,
        };
        let serialized = serde_json::to_value(summary).unwrap().to_string();
        assert!(!serialized.contains("example.net"));
    }

    #[test]
    fn exposes_safe_file_details_without_transfer_secrets() {
        let event = share_event(
            "share.offer",
            serde_json::json!({
                "type": "file",
                "transferId": "transfer_123",
                "filename": "private-document.pdf",
                "mimeType": "application/pdf",
                "size": 1024,
                "sha256": "a".repeat(64),
                "sourceName": "Phone"
            }),
        );
        let offer = pending_share_offer(&event, "server").unwrap();
        assert!(matches!(offer.content, ShareContent::File(_)));
        let store = Arc::new(Mutex::new(HashMap::from([(
            offer_key(&offer.server_id, &offer.id),
            offer,
        )])));
        let serialized =
            serde_json::to_string(&offer_summaries(&store, "server").unwrap()).unwrap();
        assert!(serialized.contains("\"kind\":\"file\""));
        assert!(serialized.contains("private-document.pdf"));
        assert!(serialized.contains("\"size\":1024"));
        assert!(!serialized.contains("transfer_123"));
        assert!(!serialized.contains(&"a".repeat(64)));
    }

    #[test]
    fn rejects_invalid_file_offers() {
        for payload in [
            serde_json::json!({
                "type": "file", "transferId": "transfer_123", "filename": "../escape",
                "mimeType": "application/octet-stream", "size": 12, "sha256": "a".repeat(64),
                "sourceName": "Phone"
            }),
            serde_json::json!({
                "type": "file", "transferId": "bad/id", "filename": "safe.bin",
                "mimeType": "application/octet-stream", "size": 12, "sha256": "a".repeat(64),
                "sourceName": "Phone"
            }),
            serde_json::json!({
                "type": "file", "transferId": "transfer_123", "filename": "safe.bin",
                "mimeType": "application/octet-stream", "size": MAX_SHARE_FILE_BYTES + 1,
                "sha256": "a".repeat(64), "sourceName": "Phone"
            }),
            serde_json::json!({
                "type": "file", "transferId": "transfer_123", "filename": "safe.bin",
                "mimeType": "application/octet-stream", "size": 12, "sha256": "not-a-hash",
                "sourceName": "Phone"
            }),
        ] {
            assert!(pending_share_offer(&share_event("share.offer", payload), "server").is_none());
        }
    }

    #[test]
    fn rejects_file_size_and_checksum_mismatches() {
        let expected = "a".repeat(64);
        assert!(file_integrity_matches(12, &expected, 12, &expected));
        assert!(!file_integrity_matches(12, &expected, 11, &expected));
        assert!(!file_integrity_matches(12, &expected, 12, &"b".repeat(64)));
    }

    #[test]
    fn rejects_unsafe_urls_and_control_characters_in_offers() {
        let unsafe_url = share_event(
            "share.offer",
            serde_json::json!({
                "type": "url",
                "value": "javascript:alert(1)",
                "sourceName": "Phone"
            }),
        );
        let unsafe_text = share_event(
            "clipboard.offer",
            serde_json::json!({ "text": "secret\u{0000}", "sourceName": "Phone" }),
        );

        assert!(pending_share_offer(&unsafe_url, "server").is_none());
        assert!(pending_share_offer(&unsafe_text, "server").is_none());
    }

    #[test]
    fn validates_reminder_inputs_and_custom_repeats() {
        assert_eq!(validate_reminder_title("  Pay rent  ").unwrap(), "Pay rent");
        assert!(validate_reminder_title("").is_err());
        assert!(validate_reminder_title("bad\nline").is_err());
        assert!(validate_reminder_repeat("none").is_ok());
        assert!(validate_reminder_repeat("daily").is_ok());
        assert!(validate_reminder_repeat("every:2:week").is_ok());
        assert!(validate_reminder_repeat("every:1:week").is_err());
        assert!(validate_reminder_repeat("every:2:minute").is_err());
    }

    #[test]
    fn validates_bounded_reminder_responses() {
        let reminder = ReminderSummary {
            id: "reminder_123".into(),
            title: "Review HomePlace".into(),
            at: OffsetDateTime::now_utc().format(&Rfc3339).unwrap(),
            repeat: "weekly".into(),
        };
        assert_eq!(validate_reminders(vec![reminder]).unwrap().len(), 1);

        let invalid = ReminderSummary {
            id: "../escape".into(),
            title: "Review HomePlace".into(),
            at: OffsetDateTime::now_utc().format(&Rfc3339).unwrap(),
            repeat: "weekly".into(),
        };
        assert!(validate_reminders(vec![invalid]).is_err());
    }

    #[test]
    fn validates_bounded_calendar_responses() {
        let event = CalendarEventSummary {
            id: "event_123".into(),
            summary: "Planning".into(),
            start: "2026-09-20T07:00:00.000Z".into(),
            end: "2026-09-20T08:00:00.000Z".into(),
            all_day: false,
            location: Some("Office".into()),
        };
        assert_eq!(validate_calendar_events(vec![event]).unwrap().len(), 1);

        let invalid = CalendarEventSummary {
            id: "../event".into(),
            summary: "Planning".into(),
            start: "2026-09-21".into(),
            end: "2026-09-20".into(),
            all_day: true,
            location: None,
        };
        assert!(validate_calendar_events(vec![invalid]).is_err());
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

    fn share_event(kind: &str, payload: serde_json::Value) -> HeartbeatEvent {
        HeartbeatEvent {
            protocol: PROTOCOL_MAX,
            id: "offer_123".into(),
            kind: kind.into(),
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
