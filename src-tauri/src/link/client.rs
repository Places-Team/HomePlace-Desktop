use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
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
use tokio::{io::AsyncWriteExt, sync::mpsc, time::sleep};
use tokio_util::io::ReaderStream;
use url::{Host, Url};
use zeroize::Zeroizing;

use super::{
    capabilities::initial_capabilities,
    identity::{self, PendingPairing, StoredProfile},
    protocol::{LinkInfo, PROTOCOL_MAX, ProtocolError, validate_link_info},
};
use crate::platform;

const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const LEGACY_FILE_LIMIT_BYTES: u64 = 500 * 1024 * 1024;
const MAX_SUPPORTED_FILE_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const MAX_EXCHANGE_TEXT_BYTES: usize = 16 * 1024;
const EXCHANGE_LIFETIMES: [u32; 3] = [600, 3600, 86400];
const FILE_TRANSFER_TIMEOUT_SECONDS: u64 = 12 * 60 * 60;
const HEARTBEAT_EVENT: &str = "link-heartbeat";
const HEALTHY_HEARTBEAT_SECONDS: u64 = 30;
const MAX_RETRY_SECONDS: u64 = 5 * 60;
const CLIPBOARD_POLL_MILLISECONDS: u64 = 900;
const MAX_CLIPBOARD_HISTORY_ITEMS: usize = 50;
const CLIPBOARD_HISTORY_EVENT: &str = "clipboard-history-changed";

pub struct HeartbeatService {
    wake: mpsc::Sender<()>,
    offers: OfferStore,
    clipboard_hash: Arc<Mutex<Option<String>>>,
    clipboard_enabled: Arc<AtomicBool>,
    notifications_enabled: Arc<AtomicBool>,
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
    pub(crate) server_id: String,
    server_name: String,
    realtime: bool,
    reduced_security: bool,
    max_file_bytes: Option<u64>,
    pub(crate) file_batches: bool,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemNotificationStatus {
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
    #[serde(default)]
    supports_file_batch: bool,
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
pub struct AccountDevice {
    id: String,
    name: String,
    platform: String,
    platform_version: String,
    app_version: String,
    online: bool,
    last_seen_at: Option<String>,
    owner_name: String,
    current_device: bool,
}

#[derive(Deserialize)]
struct AccountDevicesEnvelope {
    devices: Vec<AccountDevice>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationHistoryItem {
    id: String,
    title: String,
    body: String,
    tag: Option<String>,
    #[serde(default)]
    urgent: bool,
    created_at: String,
    delivered_at: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationHistoryPage {
    notifications: Vec<NotificationHistoryItem>,
    next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeSummary {
    token: String,
    #[serde(default)]
    url: String,
    kind: String,
    access: String,
    filename: Option<String>,
    size: Option<u64>,
    delete_after_open: bool,
    created_at: String,
    expires_at: String,
}

#[derive(Deserialize)]
struct ExchangeListEnvelope {
    exchanges: Vec<ExchangeSummary>,
}

#[derive(Deserialize)]
struct ExchangeEnvelope {
    exchange: ExchangeSummary,
}

#[derive(Deserialize)]
struct ExchangeRecipientEnvelope {
    exchange: ExchangeRecipient,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExchangeRecipient {
    kind: String,
    access: String,
    filename: Option<String>,
    size: Option<u64>,
    #[serde(rename = "deleteAfterOpen")]
    _delete_after_open: bool,
    expires_at: String,
}

#[derive(Deserialize)]
struct ExchangeTextEnvelope {
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRetrieval {
    kind: String,
    text: Option<String>,
    saved_path: Option<String>,
    name: Option<String>,
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
pub struct CompletedReminderSummary {
    id: String,
    title: String,
    at: String,
    repeat: String,
    completed_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverviewReminderSummary {
    id: String,
    title: String,
    at: String,
    repeat: String,
    done: bool,
    completed_at: Option<String>,
}

#[derive(Deserialize)]
struct ReminderHistoryEnvelope {
    reminders: Vec<OverviewReminderSummary>,
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

#[derive(Clone, Deserialize)]
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTransferProgress {
    transfer_id: String,
    file_name: String,
    transferred_bytes: u64,
    total_bytes: u64,
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
        max_file_bytes: info.limits.map(|limits| limits.max_file_bytes),
        file_batches: info.features.file_batches,
    })
}

#[tauri::command]
pub async fn get_file_transfer_limit() -> Result<u64, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let verified = verify_server(profile.address.clone()).await?;
    if verified.server_id != profile.server_id {
        return Err("The Link API belongs to a different HomePlace server.".into());
    }
    match verified.max_file_bytes {
        Some(limit) if (1..=MAX_SUPPORTED_FILE_BYTES).contains(&limit) => Ok(limit),
        Some(_) => Err("The HomePlace server returned an invalid file limit.".into()),
        None => Ok(LEGACY_FILE_LIMIT_BYTES),
    }
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
            "dashboard.read",
            "calendar.read",
            "calendar.manage",
            "reminder.manage",
            "ideas.manage",
            "plants.manage",
            "media.request",
            "telegram.send",
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

    let response = ensure_pairing_success(response).await?;
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
                file_batch_approved: true,
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
    let notifications_enabled = identity::system_notifications_enabled(&profile.server_id)?;
    service
        .notifications_enabled
        .store(notifications_enabled, Ordering::Relaxed);
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
    notifications_enabled: bool,
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
        if notifications_enabled {
            deliver_notifications(&envelope.events, |notification| {
                app.notification()
                    .builder()
                    .title(&notification.title)
                    .body(&notification.body)
                    .show()
                    .map_err(|_| ())
            })
        } else {
            let (ids, _, failures) = deliver_notifications(&envelope.events, |_| Ok(()));
            (ids, 0, failures)
        };
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
    let initial_notifications_enabled = identity::load_profile()
        .ok()
        .flatten()
        .and_then(|profile| identity::system_notifications_enabled(&profile.server_id).ok())
        .unwrap_or(true);
    let notifications_enabled = Arc::new(AtomicBool::new(initial_notifications_enabled));
    let worker_offers = Arc::clone(&offers);
    let worker_clipboard_hash = Arc::clone(&clipboard_hash);
    let worker_clipboard_enabled = Arc::clone(&clipboard_enabled);
    let worker_notifications_enabled = Arc::clone(&notifications_enabled);
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
                    worker_notifications_enabled.load(Ordering::Relaxed),
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
        let mut last_failure: Option<(String, Instant, u32)> = None;
        loop {
            sleep(Duration::from_millis(CLIPBOARD_POLL_MILLISECONDS)).await;
            let Some(profile) = identity::load_profile().ok().flatten() else {
                context = None;
                last_failure = None;
                polling_clipboard_enabled.store(false, Ordering::Relaxed);
                continue;
            };
            let enabled = polling_clipboard_enabled.load(Ordering::Relaxed);
            let next_context = (profile.server_id.clone(), enabled);
            if context.as_ref() != Some(&next_context) {
                last_failure = None;
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
            if polling_clipboard_hash
                .lock()
                .ok()
                .is_some_and(|current| current.as_deref() == Some(digest.as_str()))
            {
                continue;
            }
            if clipboard_retry_pending(&digest, last_failure.as_ref(), Instant::now()) {
                continue;
            }
            let Ok(credential) = identity::load_credential(&profile.server_id) else {
                continue;
            };
            match relay_clipboard_update(&profile, credential.as_str(), &text).await {
                Ok(()) => {
                    last_failure = None;
                    if clipboard_app
                        .clipboard()
                        .read_text()
                        .ok()
                        .is_some_and(|current| clipboard_digest(&current) == digest)
                        && let Ok(mut current) = polling_clipboard_hash.lock()
                    {
                        *current = Some(digest);
                    }
                    let _ = record_clipboard_history(&clipboard_app, &text, "sent");
                }
                Err(_) => {
                    let attempts = last_failure
                        .as_ref()
                        .filter(|(failed_digest, _, _)| failed_digest == &digest)
                        .map_or(1, |(_, _, attempts)| attempts.saturating_add(1));
                    last_failure = Some((digest, Instant::now(), attempts));
                }
            }
        }
    });
    HeartbeatService {
        wake,
        offers,
        clipboard_hash,
        clipboard_enabled,
        notifications_enabled,
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
pub fn system_notification_status() -> Result<SystemNotificationStatus, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    Ok(SystemNotificationStatus {
        enabled: identity::system_notifications_enabled(&profile.server_id)?,
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
pub fn remove_clipboard_history(
    app: AppHandle,
    id: String,
) -> Result<Vec<ClipboardHistoryEntry>, String> {
    if !safe_identifier(&id) {
        return Err("The clipboard history entry is invalid.".into());
    }
    let mut entries = load_clipboard_history(&app)?;
    entries.retain(|entry| entry.id != id);
    let encoded = serde_json::to_vec(&entries)
        .map_err(|_| "Could not encode clipboard history.".to_string())?;
    fs::write(clipboard_history_path(&app)?, encoded)
        .map_err(|_| "Could not save clipboard history.".to_string())?;
    Ok(entries)
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
                "Quick sharing is disabled for this device. Enable it in HomePlace Devices.".into(),
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
pub async fn list_account_devices() -> Result<Vec<AccountDevice>, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/devices")
        .map_err(|_| "Could not create the devices API address.".to_string())?;
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
        403 => return Err("This device is not assigned to a HomePlace account.".into()),
        _ => ensure_success(&response, "account device list")?,
    }
    let envelope: AccountDevicesEnvelope = read_bounded_json(response).await?;
    if envelope.devices.len() > 100
        || envelope.devices.iter().any(|device| {
            !safe_identifier(&device.id)
                || bounded_device_name(&device.name).is_err()
                || bounded_device_name(&device.owner_name).is_err()
                || device.platform.len() > 24
                || device.platform_version.len() > 40
                || device.app_version.len() > 40
                || device
                    .last_seen_at
                    .as_deref()
                    .is_some_and(|value| OffsetDateTime::parse(value, &Rfc3339).is_err())
        })
    {
        return Err("HomePlace returned an invalid account device list.".into());
    }
    Ok(envelope.devices)
}

fn validate_notification_history(page: &NotificationHistoryPage) -> Result<(), String> {
    if page.notifications.len() > 50
        || page
            .next_cursor
            .as_deref()
            .is_some_and(|cursor| !valid_notification_cursor(cursor))
        || page.notifications.iter().any(|item| {
            !valid_notification_cursor(&item.id)
                || item.title.trim().is_empty()
                || item.title.len() > 480
                || item.body.trim().is_empty()
                || item.body.len() > 8000
                || item.tag.as_deref().is_some_and(|tag| tag.len() > 480)
                || OffsetDateTime::parse(&item.created_at, &Rfc3339).is_err()
                || item
                    .delivered_at
                    .as_deref()
                    .is_some_and(|date| OffsetDateTime::parse(date, &Rfc3339).is_err())
        })
    {
        return Err("The HomePlace server returned an invalid notification history.".into());
    }
    Ok(())
}

fn valid_notification_cursor(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[cfg(test)]
mod notification_history_tests {
    use super::*;

    #[test]
    fn validates_notification_page_and_cursor() {
        let item = NotificationHistoryItem {
            id: "event_123".into(),
            title: "Server alert".into(),
            body: "The server is unavailable.".into(),
            tag: Some("health".into()),
            urgent: true,
            created_at: "2026-09-27T10:00:00.000Z".into(),
            delivered_at: Some("2026-09-27T10:00:01.000Z".into()),
        };
        let page = NotificationHistoryPage {
            notifications: vec![item.clone()],
            next_cursor: Some(item.id.clone()),
        };
        assert!(validate_notification_history(&page).is_ok());
        assert!(!valid_notification_cursor("../event"));
        assert!(
            validate_notification_history(&NotificationHistoryPage {
                notifications: vec![NotificationHistoryItem {
                    created_at: "yesterday".into(),
                    ..item
                }],
                next_cursor: None,
            })
            .is_err()
        );
    }
}

#[tauri::command]
pub async fn list_notification_history(
    cursor: Option<String>,
) -> Result<NotificationHistoryPage, String> {
    if cursor
        .as_deref()
        .is_some_and(|value| !valid_notification_cursor(value))
    {
        return Err("The notification history cursor is invalid.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let mut endpoint = base_url
        .join("api/link/notifications")
        .map_err(|_| "Could not create notification history API address.".to_string())?;
    {
        let mut query = endpoint.query_pairs_mut();
        query.append_pair("limit", "50");
        if let Some(cursor) = cursor.as_deref() {
            query.append_pair("cursor", cursor);
        }
    }
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
        403 => return Err("Notification history is not available for this device.".into()),
        404 if cursor.is_some() => {
            return Err(
                "This notification history page is no longer available. Refresh the list.".into(),
            );
        }
        404 => return Err("Update the HomePlace server to enable notification history.".into()),
        _ => ensure_success(&response, "notification history")?,
    }
    let page: NotificationHistoryPage = read_bounded_json_with_limit(response, 160 * 1024).await?;
    validate_notification_history(&page)?;
    Ok(page)
}

fn valid_exchange_token(token: &str) -> bool {
    token.len() == 22
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn validate_exchange_options(expires_in_seconds: u32, access: &str) -> Result<(), String> {
    if !EXCHANGE_LIFETIMES.contains(&expires_in_seconds) || !matches!(access, "account" | "link") {
        return Err("The exchange options are invalid.".into());
    }
    Ok(())
}

fn validate_exchange_summary(exchange: &ExchangeSummary) -> Result<(), String> {
    if !valid_exchange_token(&exchange.token)
        || !matches!(exchange.kind.as_str(), "text" | "file")
        || !matches!(exchange.access.as_str(), "account" | "link")
        || (exchange.kind == "file" && (exchange.filename.is_none() || exchange.size.is_none()))
        || exchange
            .filename
            .as_deref()
            .is_some_and(|name| !valid_exchange_filename(name))
        || exchange
            .size
            .is_some_and(|size| size > MAX_SUPPORTED_FILE_BYTES)
        || OffsetDateTime::parse(&exchange.created_at, &Rfc3339).is_err()
        || OffsetDateTime::parse(&exchange.expires_at, &Rfc3339).is_err()
    {
        return Err("The HomePlace server returned an invalid exchange.".into());
    }
    Ok(())
}

fn valid_exchange_filename(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.chars().count() <= 240
        && !name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':'))
}

fn exchange_api_status(response: &Response, action: &str) -> Result<(), String> {
    match response.status().as_u16() {
        401 => Err(
            "Exchange access was denied. Check device pairing and the share.relay permission."
                .into(),
        ),
        403 => Err("This device cannot create or open exchanges. Check Link permissions.".into()),
        404 => Err("The exchange is unavailable or the HomePlace server needs an update.".into()),
        413 => Err("The exchange exceeds the server size limit.".into()),
        429 => Err("Too many exchange requests. Try again later.".into()),
        _ => ensure_success(response, action),
    }
}

fn exchange_share_url(base_url: &Url, token: &str) -> Result<String, String> {
    if !valid_exchange_token(token) {
        return Err("The exchange code is invalid.".into());
    }
    base_url
        .join(&format!("x/{token}"))
        .map(|url| url.to_string())
        .map_err(|_| "Could not create the exchange URL.".to_string())
}

#[cfg(test)]
mod exchange_tests {
    use super::*;

    #[test]
    fn validates_exchange_codes_options_and_response() {
        let token = "AbCdEf0123456789_-abcd";
        assert!(valid_exchange_token(token));
        assert!(!valid_exchange_token("../bad"));
        assert!(validate_exchange_options(3600, "link").is_ok());
        assert!(validate_exchange_options(900, "link").is_err());
        assert!(validate_exchange_options(3600, "unknown").is_err());
        let item: ExchangeSummary = serde_json::from_value(serde_json::json!({
            "token": token,
            "kind": "file",
            "access": "account",
            "filename": "archive.zip",
            "size": 1024,
            "deleteAfterOpen": true,
            "createdAt": "2026-09-27T10:00:00.000Z",
            "expiresAt": "2026-09-27T11:00:00.000Z"
        }))
        .unwrap();
        assert!(validate_exchange_summary(&item).is_ok());
        let base = Url::parse("https://home.example.net/").unwrap();
        assert_eq!(
            exchange_share_url(&base, token).unwrap(),
            format!("https://home.example.net/x/{token}")
        );
        assert!(
            validate_exchange_summary(&ExchangeSummary {
                filename: Some("../bad".into()),
                ..item
            })
            .is_err()
        );
    }
}

#[tauri::command]
pub async fn list_exchanges() -> Result<Vec<ExchangeSummary>, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/exchange")
        .map_err(|_| "Could not create the exchange API address.".to_string())?;
    let response = workspace_http_client(20)?
        .get(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    exchange_api_status(&response, "exchange list")?;
    let mut envelope: ExchangeListEnvelope =
        read_bounded_json_with_limit(response, 128 * 1024).await?;
    if envelope.exchanges.len() > 100 {
        return Err("The HomePlace server returned too many exchanges.".into());
    }
    for exchange in &mut envelope.exchanges {
        validate_exchange_summary(exchange)?;
        exchange.url = exchange_share_url(&base_url, &exchange.token)?;
    }
    Ok(envelope.exchanges)
}

#[tauri::command]
pub async fn create_text_exchange(
    text: String,
    expires_in_seconds: u32,
    delete_after_open: bool,
    access: String,
) -> Result<ExchangeSummary, String> {
    validate_exchange_options(expires_in_seconds, &access)?;
    if text.trim().is_empty() || text.len() > MAX_EXCHANGE_TEXT_BYTES {
        return Err("Choose text between 1 byte and 16 KiB.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/exchange")
        .map_err(|_| "Could not create the exchange API address.".to_string())?;
    let response = workspace_http_client(30)?
        .post(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .json(&serde_json::json!({
            "text": text,
            "expiresInSeconds": expires_in_seconds,
            "deleteAfterOpen": delete_after_open,
            "access": access,
        }))
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    exchange_api_status(&response, "text exchange")?;
    let mut envelope: ExchangeEnvelope = read_bounded_json(response).await?;
    validate_exchange_summary(&envelope.exchange)?;
    envelope.exchange.url = exchange_share_url(&base_url, &envelope.exchange.token)?;
    Ok(envelope.exchange)
}

#[tauri::command]
pub async fn create_file_exchange(
    app: AppHandle,
    file_path: String,
    transfer_id: String,
    expires_in_seconds: u32,
    delete_after_open: bool,
    access: String,
) -> Result<ExchangeSummary, String> {
    validate_exchange_options(expires_in_seconds, &access)?;
    if !safe_identifier(&transfer_id) {
        return Err("The upload identifier is invalid.".into());
    }
    let path = PathBuf::from(file_path);
    let metadata = fs::metadata(&path)
        .map_err(|_| "The selected exchange file is unavailable.".to_string())?;
    let max_file_bytes = get_file_transfer_limit().await?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > max_file_bytes {
        return Err(format!(
            "Choose a file within the server limit of {max_file_bytes} bytes."
        ));
    }
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| {
            !name.is_empty() && name.chars().count() <= 240 && !name.chars().any(char::is_control)
        })
        .ok_or_else(|| "The selected filename is invalid.".to_string())?
        .to_owned();
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| "The selected exchange file could not be read.".to_string())?;
    let total_bytes = metadata.len();
    let progress_app = app.clone();
    let progress_transfer_id = transfer_id.clone();
    let progress_filename = filename.clone();
    let progress_step = (total_bytes / 200).max(256 * 1024);
    let mut transferred_bytes = 0_u64;
    let mut last_emitted_bytes = 0_u64;
    let _ = app.emit(
        "link-file-transfer-progress",
        FileTransferProgress {
            transfer_id: transfer_id.clone(),
            file_name: filename.clone(),
            transferred_bytes: 0,
            total_bytes,
        },
    );
    let stream = ReaderStream::new(file).map(move |chunk| {
        if let Ok(bytes) = &chunk {
            transferred_bytes = transferred_bytes.saturating_add(bytes.len() as u64);
            if transferred_bytes == total_bytes
                || transferred_bytes.saturating_sub(last_emitted_bytes) >= progress_step
            {
                last_emitted_bytes = transferred_bytes;
                let _ = progress_app.emit(
                    "link-file-transfer-progress",
                    FileTransferProgress {
                        transfer_id: progress_transfer_id.clone(),
                        file_name: progress_filename.clone(),
                        transferred_bytes,
                        total_bytes,
                    },
                );
            }
        }
        chunk
    });
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/exchange/file")
        .map_err(|_| "Could not create the file exchange API address.".to_string())?;
    let response = file_transfer_client()?
        .post(endpoint)
        .header("Accept", "application/json")
        .header("Content-Type", "application/octet-stream")
        .header("x-homeplace-size", total_bytes)
        .header(
            "x-homeplace-filename-base64",
            STANDARD.encode(filename.as_bytes()),
        )
        .header("x-homeplace-expires", expires_in_seconds)
        .header("x-homeplace-access", access)
        .header(
            "x-homeplace-delete-after-open",
            delete_after_open.to_string(),
        )
        .header(reqwest::header::CONTENT_LENGTH, total_bytes)
        .bearer_auth(credential.as_str())
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .map_err(|error| file_transfer_connection_error(&error))?;
    exchange_api_status(&response, "file exchange")?;
    let mut envelope: ExchangeEnvelope = read_bounded_json(response).await?;
    validate_exchange_summary(&envelope.exchange)?;
    envelope.exchange.url = exchange_share_url(&base_url, &envelope.exchange.token)?;
    Ok(envelope.exchange)
}

#[tauri::command]
pub async fn delete_exchange(token: String) -> Result<(), String> {
    if !valid_exchange_token(&token) {
        return Err("The exchange code is invalid.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join(&format!("api/exchange/{token}"))
        .map_err(|_| "Could not create the exchange API address.".to_string())?;
    let response = workspace_http_client(20)?
        .delete(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    exchange_api_status(&response, "exchange deletion")
}

#[tauri::command]
pub async fn retrieve_exchange(
    app: AppHandle,
    token: String,
    transfer_id: String,
) -> Result<Option<ExchangeRetrieval>, String> {
    if !valid_exchange_token(&token) || !safe_identifier(&transfer_id) {
        return Err("The exchange code is invalid.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let item_endpoint = base_url
        .join(&format!("api/exchange/{token}"))
        .map_err(|_| "Could not create the exchange API address.".to_string())?;
    let response = workspace_http_client(20)?
        .get(item_endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    exchange_api_status(&response, "exchange details")?;
    let envelope: ExchangeRecipientEnvelope = read_bounded_json(response).await?;
    let item = envelope.exchange;
    if !matches!(item.kind.as_str(), "text" | "file")
        || !matches!(item.access.as_str(), "account" | "link")
        || OffsetDateTime::parse(&item.expires_at, &Rfc3339).is_err()
    {
        return Err("The HomePlace server returned an invalid exchange.".into());
    }
    if item.kind == "text" {
        let endpoint = base_url
            .join(&format!("api/exchange/{token}/open"))
            .map_err(|_| "Could not create the text exchange address.".to_string())?;
        let response = workspace_http_client(30)?
            .post(endpoint)
            .header("Accept", "application/json")
            .bearer_auth(credential.as_str())
            .send()
            .await
            .map_err(|error| connection_error(&error))?;
        exchange_api_status(&response, "text exchange retrieval")?;
        let content: ExchangeTextEnvelope =
            read_bounded_json_with_limit(response, MAX_EXCHANGE_TEXT_BYTES * 6 + 1024).await?;
        if content.text.is_empty() || content.text.len() > MAX_EXCHANGE_TEXT_BYTES {
            return Err("The HomePlace server returned invalid exchange text.".into());
        }
        return Ok(Some(ExchangeRetrieval {
            kind: "text".into(),
            text: Some(content.text),
            saved_path: None,
            name: None,
        }));
    }

    let filename = item
        .filename
        .filter(|name| valid_exchange_filename(name))
        .ok_or_else(|| "The exchange filename is invalid.".to_string())?;
    let expected_size =
        item.size
            .filter(|size| *size > 0 && *size <= MAX_SUPPORTED_FILE_BYTES)
            .ok_or_else(|| "The exchange file size is invalid.".to_string())? as usize;
    let Some(selected) = app
        .dialog()
        .file()
        .set_file_name(&filename)
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let destination = selected
        .as_path()
        .ok_or_else(|| "Only local file destinations are supported.".to_string())?;
    let parent = destination
        .parent()
        .ok_or_else(|| "The selected file destination is invalid.".to_string())?;
    let saved_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The selected file name is invalid.".to_string())?;
    if destination.exists() {
        return Err("The selected file already exists. Choose a new filename.".into());
    }
    let endpoint = base_url
        .join(&format!("api/exchange/{token}/file"))
        .map_err(|_| "Could not create the file exchange address.".to_string())?;
    let response = file_transfer_client()?
        .get(endpoint)
        .header("Accept", "application/octet-stream")
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|error| file_transfer_connection_error(&error))?;
    exchange_api_status(&response, "file exchange retrieval")?;
    if response.content_length() != Some(expected_size as u64) {
        return Err("The exchange file size does not match its metadata.".into());
    }
    let expected_hash = response
        .headers()
        .get("x-homeplace-sha256")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "The exchange file integrity checksum is missing.".to_string())?
        .to_ascii_lowercase();
    let progress_step = (expected_size as u64 / 200).max(256 * 1024);
    let mut last_emitted_bytes = 0_u64;
    let _ = app.emit(
        "link-file-transfer-progress",
        FileTransferProgress {
            transfer_id: transfer_id.clone(),
            file_name: filename.clone(),
            transferred_bytes: 0,
            total_bytes: expected_size as u64,
        },
    );
    let temporary = parent.join(format!(
        ".{saved_name}.homeplace-{}.part",
        uuid::Uuid::new_v4()
    ));
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await
            .map_err(|_| "The temporary exchange file could not be created.".to_string())?;
        let mut actual_size = 0usize;
        let mut hasher = Sha256::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|_| "The exchange file could not be downloaded.".to_string())?;
            actual_size = actual_size
                .checked_add(chunk.len())
                .filter(|size| *size <= expected_size)
                .ok_or_else(|| "The exchange file exceeded its declared size.".to_string())?;
            if actual_size as u64 == expected_size as u64
                || (actual_size as u64).saturating_sub(last_emitted_bytes) >= progress_step
            {
                last_emitted_bytes = actual_size as u64;
                let _ = app.emit(
                    "link-file-transfer-progress",
                    FileTransferProgress {
                        transfer_id: transfer_id.clone(),
                        file_name: filename.clone(),
                        transferred_bytes: actual_size as u64,
                        total_bytes: expected_size as u64,
                    },
                );
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|_| "The exchange file could not be saved.".to_string())?;
        }
        file.flush()
            .await
            .map_err(|_| "The exchange file could not be saved.".to_string())?;
        file.sync_all()
            .await
            .map_err(|_| "The exchange file could not be saved.".to_string())?;
        drop(file);
        let actual_hash = format!("{:x}", hasher.finalize());
        if !file_integrity_matches(expected_size, &expected_hash, actual_size, &actual_hash) {
            return Err("The exchange file failed its integrity check.".to_string());
        }
        tokio::fs::hard_link(&temporary, destination)
            .await
            .map_err(|_| {
                "The verified exchange file could not be saved without replacing an existing file."
                    .to_string()
            })?;
        let _ = tokio::fs::remove_file(&temporary).await;
        Ok::<(), String>(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result?;
    Ok(Some(ExchangeRetrieval {
        kind: "file".into(),
        text: None,
        saved_path: Some(destination.to_string_lossy().into_owned()),
        name: Some(saved_name.to_owned()),
    }))
}

// The desktop workspace uses the same permission-gated, account-scoped API as Mobile.
// Credentials never cross the Tauri boundary; only bounded response data does.
#[tauri::command]
pub async fn link_mobile_overview() -> Result<serde_json::Value, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/mobile/overview")
        .map_err(|_| "Could not create dashboard API address.".to_string())?;
    let response = workspace_http_client(20)?
        .get(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    mobile_api_status(&response, "dashboard.read")?;
    let data: serde_json::Value = read_bounded_json_with_limit(response, 512 * 1024).await?;
    if !data
        .get("monitoring")
        .is_some_and(serde_json::Value::is_object)
        || !data
            .get("serverTime")
            .is_some_and(serde_json::Value::is_string)
        || !data
            .get("requests")
            .is_some_and(serde_json::Value::is_object)
        || !data
            .pointer("/requests/instances")
            .is_some_and(serde_json::Value::is_array)
        || !data
            .pointer("/monitoring/services")
            .is_some_and(serde_json::Value::is_array)
        || !data
            .pointer("/monitoring/containers/items")
            .is_some_and(serde_json::Value::is_array)
        || !data
            .pointer("/monitoring/recent")
            .is_some_and(serde_json::Value::is_array)
    {
        return Err("The HomePlace server returned an invalid dashboard response.".into());
    }
    Ok(serde_json::json!({
        "serverTime": data.get("serverTime"),
        "requests": data.get("requests"),
        "monitoring": data.get("monitoring"),
        "telegram": data.get("telegram"),
    }))
}

#[tauri::command]
pub async fn link_plants(app: AppHandle) -> Result<serde_json::Value, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/plants")
        .map_err(|_| "Could not create plants API address.".to_string())?;
    let response = workspace_http_client(20)?
        .get(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    mobile_api_status(&response, "plants.manage")?;
    let data: serde_json::Value = read_bounded_json_with_limit(response, 512 * 1024).await?;
    if !data.get("plants").is_some_and(serde_json::Value::is_array) {
        return Err("The HomePlace server returned invalid plants.".into());
    }
    reconcile_plant_photo_cache(&app, &profile, &data);
    Ok(data)
}

const MAX_PLANT_PHOTO_BYTES: usize = 12 * 1024 * 1024;

fn plant_photo_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn plant_photo_cache_name(
    server_id: &str,
    device_id: &str,
    plant_id: &str,
    version: &str,
) -> String {
    let scope = format!(
        "{:x}",
        Sha256::digest(format!("{server_id}:{device_id}").as_bytes())
    );
    let revision = format!("{:x}", Sha256::digest(version.as_bytes()));
    format!("{scope}/{plant_id}-{revision}.bin")
}

fn reconcile_plant_photo_cache(app: &AppHandle, profile: &StoredProfile, data: &serde_json::Value) {
    let Some(plants) = data.get("plants").and_then(serde_json::Value::as_array) else {
        return;
    };
    if !plants.iter().all(|plant| plant.get("photo").is_some()) {
        return;
    }
    let scope = format!(
        "{:x}",
        Sha256::digest(format!("{}:{}", profile.server_id, profile.device_id).as_bytes())
    );
    let Ok(root) = app.path().app_data_dir() else {
        return;
    };
    let directory = root.join("plant-photos").join(scope);
    let expected: HashSet<String> = plants
        .iter()
        .filter(|plant| {
            plant
                .get("deletedAt")
                .is_some_and(serde_json::Value::is_null)
        })
        .filter_map(|plant| {
            let id = plant.get("clientId")?.as_str()?;
            if uuid::Uuid::parse_str(id).is_err() {
                return None;
            }
            let version = plant.pointer("/photo/version")?.as_str()?;
            Some(
                plant_photo_cache_name(&profile.server_id, &profile.device_id, id, version)
                    .rsplit('/')
                    .next()?
                    .to_string(),
            )
        })
        .collect();
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.ends_with(".bin") && !expected.contains(name) {
            let _ = fs::remove_file(path);
        }
    }
}

fn plant_photo_cache_path(
    app: &AppHandle,
    profile: &StoredProfile,
    plant_id: &str,
    version: &str,
) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not access private plant photo storage.".to_string())?
        .join("plant-photos");
    let path = root.join(plant_photo_cache_name(
        &profile.server_id,
        &profile.device_id,
        plant_id,
        version,
    ));
    let parent = path
        .parent()
        .ok_or_else(|| "The plant photo cache path is invalid.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "Could not prepare private plant photo storage.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not secure plant photo storage.".to_string())?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not secure plant photo storage.".to_string())?;
    }
    Ok(path)
}

fn prune_plant_photo_cache(path: &Path, plant_id: &str) {
    let Some(parent) = path.parent() else {
        return;
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let other = entry.path();
        if other != path
            && other
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with(&format!("{plant_id}-")) && name.ends_with(".bin")
                })
        {
            let _ = fs::remove_file(other);
        }
    }
}

fn plant_photo_data_uri(bytes: &[u8]) -> Result<String, String> {
    let mime = plant_photo_mime(bytes)
        .ok_or_else(|| "The plant photo format is unsupported.".to_string())?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn plant_photo_etag_matches(header: Option<&str>, version: &str) -> bool {
    header.is_some_and(|value| {
        value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            == Some(version)
    })
}

fn plant_photo_endpoint(profile: &StoredProfile, client_id: &str) -> Result<Url, String> {
    uuid::Uuid::parse_str(client_id).map_err(|_| "The plant identifier is invalid.".to_string())?;
    let (base_url, _) = validate_address(&profile.address)?;
    base_url
        .join(&format!("api/link/plants/{client_id}/photo"))
        .map_err(|_| "Could not create plant photo address.".to_string())
}

#[tauri::command]
pub async fn link_plant_features() -> Result<serde_json::Value, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/info")
        .map_err(|_| "Could not create Link discovery address.".to_string())?;
    let response = workspace_http_client(12)?
        .get(endpoint)
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    if !response.status().is_success() {
        return Err("HomePlace Link discovery is unavailable.".into());
    }
    let data: serde_json::Value = read_bounded_json_with_limit(response, 64 * 1024).await?;
    let info: LinkInfo = serde_json::from_value(data.clone())
        .map_err(|_| "The Link discovery response is invalid.".to_string())?;
    validate_link_info(&info, OffsetDateTime::now_utc())
        .map_err(|_| "The paired HomePlace server identity could not be verified.".to_string())?;
    if info.server.id != profile.server_id {
        return Err("The paired HomePlace server identity changed.".into());
    }
    Ok(serde_json::json!({
        "plants": data.pointer("/features/plants").and_then(serde_json::Value::as_bool).unwrap_or(false),
        "plantPhotos": data.pointer("/features/plantPhotos").and_then(serde_json::Value::as_bool).unwrap_or(false),
        "plantReminders": data.pointer("/features/plantReminders").and_then(serde_json::Value::as_bool).unwrap_or(false),
        "maxPlantPhotoBytes": data.pointer("/limits/maxPlantPhotoBytes").and_then(serde_json::Value::as_u64)
            .unwrap_or(0).min(MAX_PLANT_PHOTO_BYTES as u64),
    }))
}

#[tauri::command]
pub async fn link_plant_photo(
    app: AppHandle,
    client_id: String,
    version: String,
) -> Result<String, String> {
    if version.is_empty() || version.len() > 150 || version.chars().any(char::is_control) {
        return Err("The plant photo version is invalid.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let endpoint = plant_photo_endpoint(&profile, &client_id)?;
    let cache_path = plant_photo_cache_path(&app, &profile, &client_id, &version)?;
    if let Ok(metadata) = fs::metadata(&cache_path) {
        if metadata.len() <= MAX_PLANT_PHOTO_BYTES as u64 {
            if let Ok(bytes) = fs::read(&cache_path) {
                if let Ok(uri) = plant_photo_data_uri(&bytes) {
                    return Ok(uri);
                }
            }
        }
        let _ = fs::remove_file(&cache_path);
    }
    let credential = identity::load_credential(&profile.server_id)?;
    let response = workspace_http_client(20)?
        .get(endpoint)
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    mobile_api_status(&response, "plants.manage")?;
    let declared = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_string();
    if !matches!(declared.as_str(), "image/jpeg" | "image/png" | "image/webp") {
        return Err("The server returned an unsupported plant photo.".into());
    }
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok());
    if !plant_photo_etag_matches(etag, &version) {
        return Err("The plant photo changed on another device. Refresh the plant list.".into());
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_PLANT_PHOTO_BYTES as u64)
    {
        return Err("The plant photo exceeds the allowed size.".into());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Could not read the plant photo.".to_string())?;
        if body.len().saturating_add(chunk.len()) > MAX_PLANT_PHOTO_BYTES {
            return Err("The plant photo exceeds the allowed size.".into());
        }
        body.extend_from_slice(&chunk);
    }
    if plant_photo_mime(&body) != Some(declared.as_str()) {
        return Err("The server returned a mismatched plant photo.".into());
    }
    let uri = plant_photo_data_uri(&body)?;
    let temporary = cache_path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(&temporary) {
        if file.write_all(&body).is_ok() && file.sync_all().is_ok() {
            let _ = fs::rename(&temporary, &cache_path);
            prune_plant_photo_cache(&cache_path, &client_id);
        }
        let _ = fs::remove_file(&temporary);
    }
    Ok(uri)
}

#[tauri::command]
pub async fn link_upload_plant_photo(
    client_id: String,
    revision: u64,
    data_uri: String,
) -> Result<serde_json::Value, String> {
    if revision == 0 || data_uri.len() > MAX_PLANT_PHOTO_BYTES * 2 {
        return Err("The plant photo request is too large or invalid.".into());
    }
    let (declared, encoded) = data_uri
        .split_once(",")
        .ok_or_else(|| "The selected image is invalid.".to_string())?;
    let declared = declared
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .ok_or_else(|| "The selected image is invalid.".to_string())?;
    if !matches!(declared, "image/jpeg" | "image/png" | "image/webp") {
        return Err("Choose a JPEG, PNG or WebP image.".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "The selected image could not be read.".to_string())?;
    if bytes.is_empty()
        || bytes.len() > MAX_PLANT_PHOTO_BYTES
        || plant_photo_mime(&bytes) != Some(declared)
    {
        return Err("The selected image format or size is invalid.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let endpoint = plant_photo_endpoint(&profile, &client_id)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let response = workspace_http_client(40)?
        .post(endpoint)
        .bearer_auth(credential.as_str())
        .header(reqwest::header::CONTENT_TYPE, declared)
        .header(reqwest::header::IF_MATCH, revision.to_string())
        .body(bytes)
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    let conflict = response.status() == reqwest::StatusCode::CONFLICT;
    if !conflict {
        mobile_api_status(&response, "plants.manage")?;
    }
    let data: serde_json::Value = read_bounded_json_with_limit(response, 64 * 1024).await?;
    if conflict {
        return Ok(serde_json::json!({ "conflict": true, "plant": data.get("plant") }));
    }
    if !data.get("plant").is_some_and(serde_json::Value::is_object) {
        return Err("The server returned an invalid plant photo result.".into());
    }
    Ok(data)
}

#[tauri::command]
pub async fn link_delete_plant_photo(
    client_id: String,
    revision: u64,
) -> Result<serde_json::Value, String> {
    if revision == 0 {
        return Err("The plant revision is invalid.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let endpoint = plant_photo_endpoint(&profile, &client_id)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let response = workspace_http_client(20)?
        .delete(endpoint)
        .bearer_auth(credential.as_str())
        .header(reqwest::header::IF_MATCH, revision.to_string())
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    let conflict = response.status() == reqwest::StatusCode::CONFLICT;
    if !conflict {
        mobile_api_status(&response, "plants.manage")?;
    }
    let data: serde_json::Value = read_bounded_json_with_limit(response, 64 * 1024).await?;
    if conflict {
        return Ok(serde_json::json!({ "conflict": true, "plant": data.get("plant") }));
    }
    if !data.get("plant").is_some_and(serde_json::Value::is_object) {
        return Err("The server returned an invalid plant photo result.".into());
    }
    Ok(data)
}

#[tauri::command]
pub async fn link_plant_settings(
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if body
        .as_ref()
        .is_some_and(|value| !value.is_object() || value.to_string().len() > 2048)
    {
        return Err("The plant reminder settings are invalid.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/plants/settings")
        .map_err(|_| "Could not create plant settings address.".to_string())?;
    let client = workspace_http_client(20)?;
    let request = if let Some(value) = body {
        client.patch(endpoint).json(&value)
    } else {
        client.get(endpoint)
    };
    let response = request
        .bearer_auth(credential.as_str())
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    mobile_api_status(&response, "plants.manage")?;
    let data: serde_json::Value = read_bounded_json_with_limit(response, 32 * 1024).await?;
    if !data
        .get("settings")
        .is_some_and(serde_json::Value::is_object)
    {
        return Err("The server returned invalid plant reminder settings.".into());
    }
    Ok(data)
}

#[tauri::command]
pub async fn link_change_plant(body: serde_json::Value) -> Result<serde_json::Value, String> {
    if !body.is_object() || body.to_string().len() > 8 * 1024 {
        return Err("The plant request is invalid.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/plants")
        .map_err(|_| "Could not create plants API address.".to_string())?;
    let response = workspace_http_client(20)?
        .post(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .json(&body)
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    let conflict = response.status() == reqwest::StatusCode::CONFLICT;
    if !conflict {
        mobile_api_status(&response, "plants.manage")?;
    }
    let data: serde_json::Value = read_bounded_json_with_limit(response, 64 * 1024).await?;
    if conflict {
        return Ok(serde_json::json!({ "conflict": true, "plant": data.get("plant") }));
    }
    if !data.get("plant").is_some_and(serde_json::Value::is_object) {
        return Err("The HomePlace server returned an invalid plant.".into());
    }
    Ok(data)
}

#[tauri::command]
pub async fn link_telegram_status() -> Result<serde_json::Value, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/mobile/telegram")
        .map_err(|_| "Could not create Telegram API address.".to_string())?;
    let response = workspace_http_client(12)?
        .get(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    if response.status().as_u16() == 405 {
        return Err("This HomePlace server does not support Telegram status yet.".into());
    }
    mobile_api_status(&response, "dashboard.read")?;
    let data: serde_json::Value = read_bounded_json_with_limit(response, 4096).await?;
    if !data
        .get("connected")
        .is_some_and(serde_json::Value::is_boolean)
        || !data
            .get("enabled")
            .is_some_and(serde_json::Value::is_boolean)
        || !data
            .get("canTest")
            .is_some_and(serde_json::Value::is_boolean)
    {
        return Err("The HomePlace server returned an invalid Telegram status.".into());
    }
    Ok(data)
}

#[tauri::command]
pub async fn link_telegram_test() -> Result<(), String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/mobile/telegram")
        .map_err(|_| "Could not create Telegram API address.".to_string())?;
    let response = workspace_http_client(20)?
        .post(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    if response.status().as_u16() == 429 {
        return Err("Too many Telegram tests. Wait a minute and try again.".into());
    }
    if response.status().as_u16() == 409 {
        return Err("Telegram is not enabled on the HomePlace server.".into());
    }
    mobile_api_status(&response, "telegram.send")?;
    let data: serde_json::Value = read_bounded_json_with_limit(response, 4096).await?;
    if data.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("HomePlace could not deliver the Telegram test message.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn link_media_catalog(
    query: String,
    kind: String,
    category: String,
    page: u32,
    language: String,
) -> Result<serde_json::Value, String> {
    let query = query.trim();
    if query.chars().count() > 120
        || query.chars().any(char::is_control)
        || (!query.is_empty() && query.chars().count() < 2)
        || !matches!(kind.as_str(), "all" | "movie" | "tv")
        || !matches!(category.as_str(), "all" | "anime")
        || !(1..=100).contains(&page)
        || !matches!(language.as_str(), "ru" | "en")
    {
        return Err("The media catalog request is invalid.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let mut endpoint = base_url
        .join("api/link/media")
        .map_err(|_| "Could not create media catalog API address.".to_string())?;
    {
        let mut params = endpoint.query_pairs_mut();
        if !query.is_empty() {
            params.append_pair("q", query);
        }
        params
            .append_pair("kind", &kind)
            .append_pair("category", &category)
            .append_pair("page", &page.to_string())
            .append_pair("lang", &language);
    }
    let response = workspace_http_client(25)?
        .get(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    mobile_api_status(&response, "media.request")?;
    let data: serde_json::Value = read_bounded_json_with_limit(response, 512 * 1024).await?;
    if !data
        .get("configured")
        .is_some_and(serde_json::Value::is_boolean)
        || !data.get("items").is_some_and(serde_json::Value::is_array)
    {
        return Err("The HomePlace server returned an invalid media catalog.".into());
    }
    Ok(data)
}

#[tauri::command]
pub async fn link_media_details(
    kind: String,
    id: u32,
    language: String,
) -> Result<serde_json::Value, String> {
    if !matches!(kind.as_str(), "movie" | "tv")
        || id == 0
        || !matches!(language.as_str(), "ru" | "en")
    {
        return Err("The media details request is invalid.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let mut endpoint = base_url
        .join(&format!("api/link/media/{kind}/{id}"))
        .map_err(|_| "Could not create media details API address.".to_string())?;
    endpoint.query_pairs_mut().append_pair("lang", &language);
    let response = workspace_http_client(25)?
        .get(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("Media details are unavailable on the HomePlace server.".into());
    }
    mobile_api_status(&response, "media.request")?;
    let data: serde_json::Value = read_bounded_json_with_limit(response, 256 * 1024).await?;
    if !data
        .get("details")
        .is_some_and(serde_json::Value::is_object)
        || !data
            .get("profiles")
            .is_some_and(serde_json::Value::is_array)
    {
        return Err("The HomePlace server returned invalid media details.".into());
    }
    Ok(data)
}

#[tauri::command]
pub async fn link_media_catalog_requests() -> Result<serde_json::Value, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/media/requests")
        .map_err(|_| "Could not create media requests API address.".to_string())?;
    let response = workspace_http_client(25)?
        .get(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    mobile_api_status(&response, "media.request")?;
    let data: serde_json::Value = read_bounded_json_with_limit(response, 256 * 1024).await?;
    if !data
        .get("requests")
        .is_some_and(serde_json::Value::is_array)
    {
        return Err("The HomePlace server returned invalid media requests.".into());
    }
    Ok(data)
}

#[tauri::command]
pub async fn link_create_catalog_request(
    kind: String,
    media_id: u32,
    seasons: Option<Vec<u32>>,
    profile_key: Option<String>,
) -> Result<serde_json::Value, String> {
    if !matches!(kind.as_str(), "movie" | "tv")
        || media_id == 0
        || seasons.as_ref().is_some_and(|values| {
            values.len() > 100 || values.iter().any(|value| !(1..=100).contains(value))
        })
        || profile_key
            .as_ref()
            .is_some_and(|value| value.len() > 150 || value.chars().any(char::is_control))
    {
        return Err("The media request is invalid.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/media/requests")
        .map_err(|_| "Could not create media request API address.".to_string())?;
    let mut body = serde_json::json!({ "kind": kind, "mediaId": media_id });
    if let Some(values) = seasons {
        body["seasons"] = serde_json::json!(values);
    }
    if let Some(value) = profile_key {
        body["profileKey"] = serde_json::json!(value);
    }
    let response = workspace_http_client(30)?
        .post(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .json(&body)
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    mobile_api_status(&response, "media.request")?;
    let accepted = response.status().is_success();
    let data: serde_json::Value = read_bounded_json_with_limit(response, 64 * 1024).await?;
    if !accepted || data.get("ok") != Some(&serde_json::Value::Bool(true)) {
        return Err(data
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("HomePlace could not create the media request.")
            .chars()
            .take(240)
            .collect());
    }
    Ok(data)
}

#[tauri::command]
pub async fn link_media_image(path: String) -> Result<String, String> {
    if path.len() > 500
        || !path.starts_with("/api/media/")
        || path.contains("..")
        || path.chars().any(char::is_control)
    {
        return Err("The media image address is invalid.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join(path.trim_start_matches('/'))
        .map_err(|_| "Could not create media image address.".to_string())?;
    if endpoint.origin() != base_url.origin()
        || !matches!(
            endpoint.path(),
            "/api/media/tmdb-image" | "/api/media/jellyfin-image"
        ) && !endpoint.path().starts_with("/api/media/jellyfin-image/")
    {
        return Err("The media image address is invalid.".into());
    }
    let response = workspace_http_client(20)?
        .get(endpoint)
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    if !response.status().is_success() {
        return Err("The media image is unavailable.".into());
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_string();
    if !matches!(mime.as_str(), "image/jpeg" | "image/png" | "image/webp") {
        return Err("The media image has an unsupported format.".into());
    }
    if response
        .content_length()
        .is_some_and(|size| size > 8 * 1024 * 1024)
    {
        return Err("The media image is too large.".into());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The media image could not be read.".to_string())?;
        if body.len().saturating_add(chunk.len()) > 8 * 1024 * 1024 {
            return Err("The media image is too large.".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(&body)))
}

#[tauri::command]
pub async fn link_media_search(query: String) -> Result<serde_json::Value, String> {
    let query = query.trim();
    if query.chars().count() < 2
        || query.chars().count() > 80
        || query.chars().any(char::is_control)
    {
        return Err("Enter 2 to 80 characters to search media.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let mut endpoint = base_url
        .join("api/link/mobile/requests/search")
        .map_err(|_| "Could not create media search API address.".to_string())?;
    endpoint.query_pairs_mut().append_pair("q", query);
    let response = workspace_http_client(20)?
        .get(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    mobile_api_status(&response, "media.request")?;
    let data: serde_json::Value = read_bounded_json_with_limit(response, 256 * 1024).await?;
    if !data.get("results").is_some_and(serde_json::Value::is_array) {
        return Err("The HomePlace server returned invalid media results.".into());
    }
    Ok(data)
}

#[tauri::command]
pub async fn link_media_request(
    instance_label: String,
    external_id: u64,
) -> Result<serde_json::Value, String> {
    let label = instance_label.trim();
    if label.is_empty()
        || label.chars().count() > 120
        || label.chars().any(char::is_control)
        || external_id == 0
    {
        return Err("The media request is invalid.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/mobile/requests")
        .map_err(|_| "Could not create media request API address.".to_string())?;
    let response = workspace_http_client(30)?
        .post(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .json(&serde_json::json!({"instanceLabel": label, "externalId": external_id}))
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    mobile_api_status(&response, "media.request")?;
    let success = response.status().is_success();
    let data: serde_json::Value = read_bounded_json(response).await?;
    if !success || data.get("ok") != Some(&serde_json::Value::Bool(true)) {
        return Err(data
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("HomePlace could not add this title.")
            .chars()
            .take(240)
            .collect());
    }
    Ok(data)
}

fn mobile_api_status(response: &Response, permission: &str) -> Result<(), String> {
    match response.status().as_u16() {
        401 => Err("HomePlace rejected this device credential. Pair the device again.".into()),
        403 => Err(format!(
            "{permission} is not approved for this device. Approve it when pairing again in HomePlace."
        )),
        404 => Err("This HomePlace server does not provide the Mobile Link API yet.".into()),
        _ => {
            if response.status().is_redirection() || response.status().is_server_error() {
                Err(format!(
                    "HomePlace returned HTTP {}.",
                    response.status().as_u16()
                ))
            } else {
                Ok(())
            }
        }
    }
}

#[tauri::command]
pub fn open_server_page(app: AppHandle, page: String) -> Result<(), String> {
    let path = match page.as_str() {
        "media" => "media",
        "monitoring" => "monitoring",
        "containers" => "containers",
        _ => return Err("The HomePlace destination is not supported.".into()),
    };
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let target = base_url
        .join(path)
        .map_err(|_| "Could not create the HomePlace page address.".to_string())?;
    app.opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|_| "Could not open HomePlace in the browser.".to_string())
}

#[tauri::command]
pub async fn list_ideas(
    cursor: Option<String>,
    query: Option<String>,
    category_id: Option<String>,
    archived: bool,
    completed: Option<bool>,
) -> Result<serde_json::Value, String> {
    if cursor
        .as_deref()
        .is_some_and(|value| !safe_identifier(value))
    {
        return Err("The idea page cursor is invalid.".into());
    }
    if category_id
        .as_deref()
        .is_some_and(|value| !safe_identifier(value))
    {
        return Err("The idea category identifier is invalid.".into());
    }
    if query
        .as_deref()
        .is_some_and(|value| value.chars().count() > 100 || value.chars().any(char::is_control))
    {
        return Err("The idea search is invalid.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let mut endpoint = base_url
        .join("api/link/ideas")
        .map_err(|_| "Could not create ideas API address.".to_string())?;
    if let Some(cursor) = cursor {
        endpoint.query_pairs_mut().append_pair("cursor", &cursor);
    }
    if let Some(query) = query.filter(|value| !value.trim().is_empty()) {
        endpoint.query_pairs_mut().append_pair("q", query.trim());
    }
    if let Some(category_id) = category_id {
        endpoint
            .query_pairs_mut()
            .append_pair("categoryId", &category_id);
    }
    if archived {
        endpoint.query_pairs_mut().append_pair("archived", "1");
    }
    if let Some(completed) = completed {
        endpoint
            .query_pairs_mut()
            .append_pair("completed", if completed { "1" } else { "0" });
    }
    let response = workspace_http_client(20)?
        .get(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    mobile_api_status(&response, "ideas.manage")?;
    let data: serde_json::Value = read_bounded_json_with_limit(response, 512 * 1024).await?;
    if !data
        .get("categories")
        .is_some_and(serde_json::Value::is_array)
        || !data.get("ideas").is_some_and(serde_json::Value::is_array)
    {
        return Err("The HomePlace server returned invalid ideas.".into());
    }
    Ok(data)
}

#[tauri::command]
pub async fn mutate_ideas(
    action: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !matches!(
        action.as_str(),
        "createCategory"
            | "renameCategory"
            | "deleteCategory"
            | "createIdea"
            | "updateIdea"
            | "deleteIdea"
            | "import"
    ) {
        return Err("The idea action is not supported.".into());
    }
    let mut body = payload
        .as_object()
        .cloned()
        .ok_or_else(|| "The idea action requires a JSON object.".to_string())?;
    body.insert("action".into(), serde_json::Value::String(action));
    let body = serde_json::Value::Object(body);
    if serde_json::to_vec(&body)
        .map_err(|_| "Could not encode idea action.".to_string())?
        .len()
        > 32 * 1024
    {
        return Err("The idea action is too large.".into());
    }
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/ideas")
        .map_err(|_| "Could not create ideas API address.".to_string())?;
    let response = workspace_http_client(30)?
        .post(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(credential.as_str())
        .json(&body)
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    mobile_api_status(&response, "ideas.manage")?;
    let success = response.status().is_success();
    let data: serde_json::Value = read_bounded_json(response).await?;
    if !success {
        return Err(data
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("HomePlace could not save this idea.")
            .chars()
            .take(240)
            .collect());
    }
    Ok(data)
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
        403 => {
            Err("Quick sharing is disabled for this device. Enable it in HomePlace Devices.".into())
        }
        404 => Err("The selected device is no longer available.".into()),
        _ => ensure_success(&response, "content share"),
    }
}

#[tauri::command]
pub async fn send_share_file(
    app: AppHandle,
    target_device_id: String,
    file_path: String,
    transfer_id: String,
) -> Result<(), String> {
    if !safe_identifier(&target_device_id) || !safe_identifier(&transfer_id) {
        return Err("The target device is invalid.".into());
    }
    let path = PathBuf::from(file_path);
    let metadata =
        fs::metadata(&path).map_err(|_| "The dropped file is no longer available.".to_string())?;
    let max_file_bytes = get_file_transfer_limit().await?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > max_file_bytes {
        return Err(format!(
            "Choose a file within the server limit of {max_file_bytes} bytes."
        ));
    }
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| {
            !name.is_empty() && name.chars().count() <= 240 && !name.chars().any(char::is_control)
        })
        .ok_or_else(|| "The dropped filename is invalid.".to_string())?
        .to_owned();
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| "The dropped file could not be read.".to_string())?;
    let total_bytes = metadata.len();
    let progress_step = (total_bytes / 200).max(256 * 1024);
    let progress_app = app.clone();
    let progress_transfer_id = transfer_id.clone();
    let progress_filename = filename.clone();
    let mut transferred_bytes = 0_u64;
    let mut last_emitted_bytes = 0_u64;
    let _ = app.emit(
        "link-file-transfer-progress",
        FileTransferProgress {
            transfer_id: transfer_id.clone(),
            file_name: filename.clone(),
            transferred_bytes: 0,
            total_bytes,
        },
    );
    let stream = ReaderStream::new(file).map(move |chunk| {
        if let Ok(bytes) = &chunk {
            transferred_bytes = transferred_bytes.saturating_add(bytes.len() as u64);
            if transferred_bytes == total_bytes
                || transferred_bytes.saturating_sub(last_emitted_bytes) >= progress_step
            {
                last_emitted_bytes = transferred_bytes;
                let _ = progress_app.emit(
                    "link-file-transfer-progress",
                    FileTransferProgress {
                        transfer_id: progress_transfer_id.clone(),
                        file_name: progress_filename.clone(),
                        transferred_bytes,
                        total_bytes,
                    },
                );
            }
        }
        chunk
    });
    let body = reqwest::Body::wrap_stream(stream);
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/mobile/share/file")
        .map_err(|_| "Could not create the file sharing API address.".to_string())?;
    let response = file_transfer_client()?
        .post(endpoint)
        .header("Accept", "application/json")
        .header("Content-Type", "application/octet-stream")
        .header("x-homeplace-target", target_device_id)
        .header(
            "x-homeplace-filename-base64",
            STANDARD.encode(filename.as_bytes()),
        )
        .header(reqwest::header::CONTENT_LENGTH, total_bytes)
        .bearer_auth(credential.as_str())
        .body(body)
        .send()
        .await
        .map_err(|error| file_transfer_connection_error(&error))?;
    match response.status().as_u16() {
        401 => Err("HomePlace rejected the device credential. Pair this device again.".into()),
        403 => {
            Err("Quick sharing is disabled for this device. Enable it in HomePlace Devices.".into())
        }
        404 => Err("The selected device is no longer available.".into()),
        413 => {
            Err("The selected file exceeds the current server limit. Refresh and try again.".into())
        }
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

#[tauri::command]
pub fn set_system_notifications(
    enabled: bool,
    service: State<'_, HeartbeatService>,
) -> Result<SystemNotificationStatus, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    identity::store_system_notifications(&profile.server_id, enabled)?;
    service
        .notifications_enabled
        .store(enabled, Ordering::Relaxed);
    service.wake();
    Ok(SystemNotificationStatus { enabled })
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
        .map_err(|_| "Could not save clipboard history.".to_string())?;
    let _ = app.emit(CLIPBOARD_HISTORY_EVENT, ());
    Ok(())
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

fn clipboard_retry_delay(attempts: u32) -> Duration {
    Duration::from_secs(
        5_u64
            .saturating_mul(1_u64 << attempts.saturating_sub(1).min(4))
            .min(60),
    )
}

fn clipboard_retry_pending(
    digest: &str,
    last_failure: Option<&(String, Instant, u32)>,
    now: Instant,
) -> bool {
    last_failure.is_some_and(|(failed_digest, at, attempts)| {
        failed_digest == digest && now.duration_since(*at) < clipboard_retry_delay(*attempts)
    })
}

#[cfg(test)]
mod clipboard_retry_tests {
    use super::*;

    #[test]
    fn retries_failed_clipboard_updates_with_a_bounded_backoff() {
        assert_eq!(clipboard_retry_delay(1), Duration::from_secs(5));
        assert_eq!(clipboard_retry_delay(2), Duration::from_secs(10));
        assert_eq!(clipboard_retry_delay(3), Duration::from_secs(20));
        assert_eq!(clipboard_retry_delay(100), Duration::from_secs(60));
        let now = Instant::now();
        let failure = ("first".to_string(), now, 1);
        assert!(clipboard_retry_pending("first", Some(&failure), now));
        assert!(!clipboard_retry_pending("second", Some(&failure), now));
        assert!(!clipboard_retry_pending(
            "first",
            Some(&failure),
            now + Duration::from_secs(5)
        ));
    }
}

#[cfg(test)]
mod heartbeat_upgrade_tests {
    use super::*;

    #[test]
    fn share_targets_require_explicit_batch_support() {
        let base = serde_json::json!({"id":"device_1","name":"Phone","platform":"android",
            "supportsText":true,"supportsUrl":true,"supportsFile":true,"online":true,
            "ownerName":"Owner","ownedByCurrentUser":true});
        let legacy: ShareTarget = serde_json::from_value(base.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(legacy).unwrap()["supportsFileBatch"],
            false
        );
        let mut modern = base;
        modern["supportsFileBatch"] = true.into();
        let modern: ShareTarget = serde_json::from_value(modern).unwrap();
        assert_eq!(
            serde_json::to_value(modern).unwrap()["supportsFileBatch"],
            true
        );
    }

    #[test]
    fn heartbeat_does_not_silently_add_unapproved_capabilities() {
        let payload = heartbeat_payload(&[]);
        assert_eq!(payload["protocol"], PROTOCOL_MAX);
        assert!(payload.get("capabilities").is_none());
    }
}

fn heartbeat_payload(acknowledged_event_ids: &[String]) -> serde_json::Value {
    // The pairing approval is the capability baseline. An older pairing must not
    // acquire newly added permissions merely because Desktop was updated.
    serde_json::json!({
        "protocol": PROTOCOL_MAX,
        "acknowledgedEventIds": acknowledged_event_ids,
    })
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
        .json(&heartbeat_payload(acknowledged_event_ids))
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
    let mut groups: Vec<(NotificationContent, Vec<String>, OffsetDateTime)> = Vec::new();

    for event in events {
        if event.kind != "notification.deliver" {
            continue;
        }

        let Ok(notification) = notification_content(event) else {
            failures += 1;
            continue;
        };
        let Ok(sent_at) = OffsetDateTime::parse(&event.sent_at, &Rfc3339) else {
            failures += 1;
            continue;
        };

        if let Some((_, event_ids, latest_at)) =
            groups.iter_mut().rev().find(|(candidate, _, at)| {
                candidate.title == notification.title
                    && candidate.body == notification.body
                    && (*at - sent_at).whole_seconds().abs() <= 10 * 60
            })
        {
            event_ids.push(event.id.clone());
            if sent_at > *latest_at {
                *latest_at = sent_at;
            }
        } else {
            groups.push((notification, vec![event.id.clone()], sent_at));
        }
    }

    for (mut notification, event_ids, _) in groups {
        if event_ids.len() > 1 {
            notification.title =
                notification_title_with_count(&notification.title, event_ids.len());
        }
        if deliver(&notification).is_ok() {
            acknowledged_event_ids.extend(event_ids);
            delivered += 1;
        } else {
            failures += 1;
        }
    }

    (acknowledged_event_ids, delivered, failures)
}

fn notification_title_with_count(title: &str, count: usize) -> String {
    let suffix = format!(" ×{count}");
    let keep = 120usize.saturating_sub(suffix.chars().count());
    let mut result = title.chars().take(keep).collect::<String>();
    result.push_str(&suffix);
    result
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
        let (title, body) = share_offer_notification(&offer);
        let _ = app.notification().builder().title(title).body(body).show();
    }

    offer_summaries(offers, &profile.server_id)
}

fn share_offer_notification(offer: &PendingShareOffer) -> (String, String) {
    let (title, subject) = match &offer.content {
        ShareContent::Url(_) => ("Incoming link", "A link".to_string()),
        ShareContent::Text(_) => ("Incoming text", "Text".to_string()),
        ShareContent::File(file) => ("Incoming file", file.filename.clone()),
    };
    (
        format!("HomePlace Link · {title}"),
        format!(
            "{subject} from {} is waiting for approval. Open HomePlace to accept it.",
            offer.source_name,
        ),
    )
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
    if size == 0 || size as u64 > MAX_SUPPORTED_FILE_BYTES {
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
    let response = file_transfer_client()?
        .get(endpoint)
        .header("Accept", "application/octet-stream")
        .bearer_auth(credential)
        .send()
        .await
        .map_err(|error| file_transfer_connection_error(&error))?;
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
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await
            .map_err(|_| "The temporary destination file could not be created.".to_string())?;
        let mut actual_size = 0usize;
        let mut hasher = Sha256::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|_| "The shared file could not be downloaded.".to_string())?;
            actual_size = actual_size
                .checked_add(chunk.len())
                .filter(|size| *size <= offer.size && *size as u64 <= MAX_SUPPORTED_FILE_BYTES)
                .ok_or_else(|| "The shared file is larger than the approved offer.".to_string())?;
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|_| "The shared file could not be saved.".to_string())?;
        }
        file.flush()
            .await
            .map_err(|_| "The shared file could not be saved.".to_string())?;
        file.sync_all()
            .await
            .map_err(|_| "The shared file could not be saved.".to_string())?;
        drop(file);

        let actual_sha256 = format!("{:x}", hasher.finalize());
        if !file_integrity_matches(offer.size, &offer.sha256, actual_size, &actual_sha256) {
            return Err("The shared file failed its integrity check.".to_string());
        }
        #[cfg(target_os = "windows")]
        if destination.exists() {
            tokio::fs::remove_file(destination)
                .await
                .map_err(|_| "The selected Windows file could not be replaced.".to_string())?;
        }
        tokio::fs::rename(&temporary, destination)
            .await
            .map_err(|_| "The shared file could not be moved to its destination.".to_string())?;
        #[cfg(unix)]
        if let Ok(directory) = tokio::fs::File::open(parent).await {
            let _ = directory.sync_all().await;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result?;
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

#[allow(dead_code)]
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
pub async fn restore_reminder(id: String) -> Result<Vec<ReminderSummary>, String> {
    mutate_reminder_by_id("reopen", id).await
}

#[tauri::command]
pub async fn clear_completed_reminders() -> Result<Vec<ReminderSummary>, String> {
    mutate_reminders(serde_json::json!({ "action": "deleteCompleted" })).await
}

#[tauri::command]
pub async fn list_completed_reminders() -> Result<Vec<CompletedReminderSummary>, String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "No paired HomePlace server profile was found.".to_string())?;
    let credential = identity::load_credential(&profile.server_id)?;
    let (base_url, _) = validate_address(&profile.address)?;
    let endpoint = base_url
        .join("api/link/reminders?includeCompleted=1")
        .map_err(|_| "Could not create reminders API address.".to_string())?;
    let response = http_client()?
        .get(endpoint)
        .bearer_auth(credential.as_str())
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| connection_error(&error))?;
    ensure_reminder_access(&response)?;
    ensure_success(&response, "completed reminders")?;
    let envelope: ReminderHistoryEnvelope = read_bounded_json(response).await?;
    normalize_completed_reminders(envelope)
}

fn normalize_completed_reminders(
    envelope: ReminderHistoryEnvelope,
) -> Result<Vec<CompletedReminderSummary>, String> {
    let mut completed = Vec::new();
    for reminder in envelope.reminders {
        if !reminder.done {
            continue;
        }
        let completed_at = reminder.completed_at;
        let active = ReminderSummary {
            id: reminder.id.clone(),
            title: reminder.title.clone(),
            at: reminder.at.clone(),
            repeat: reminder.repeat.clone(),
        };
        validate_reminders(vec![active])?;
        if let Some(value) = &completed_at {
            OffsetDateTime::parse(value, &Rfc3339).map_err(|_| {
                "The HomePlace server returned an invalid completion time.".to_string()
            })?;
        }
        completed.push(CompletedReminderSummary {
            id: reminder.id,
            title: reminder.title,
            at: reminder.at,
            repeat: reminder.repeat,
            completed_at,
        });
    }
    completed.sort_by(|left, right| right.completed_at.cmp(&left.completed_at));
    completed.truncate(100);
    Ok(completed)
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
            || !valid_received_reminder_title(&reminder.title)
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

fn valid_received_reminder_title(value: &str) -> bool {
    let title = value.trim();
    !title.is_empty() && title.chars().count() <= 2_000 && !title.chars().any(char::is_control)
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

fn workspace_http_client(timeout_seconds: u64) -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(timeout_seconds))
        .build()
        .map_err(|_| "Could not initialise the server workspace connection.".to_string())
}

pub(crate) fn file_transfer_client() -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(FILE_TRANSFER_TIMEOUT_SECONDS))
        .build()
        .map_err(|_| "Could not initialise secure file transfer.".to_string())
}

fn bounded_device_name(input: &str) -> Result<String, String> {
    let name = input.trim();
    if name.is_empty() || name.encode_utf16().count() > 80 || name.chars().any(char::is_control) {
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

pub(crate) fn validate_stored_profile(profile: &StoredProfile) -> Result<(), String> {
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

pub(crate) fn ensure_success(response: &Response, operation: &str) -> Result<(), String> {
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

#[derive(Deserialize)]
struct PairingErrorEnvelope {
    code: Option<String>,
}

async fn ensure_pairing_success(response: Response) -> Result<Response, String> {
    let status = response.status().as_u16();
    if response.status().is_success() {
        return Ok(response);
    }
    if status == 429 {
        return Err("Too many pairing attempts. Wait a minute and try again.".into());
    }
    if status == 400 {
        let code = read_bounded_json_with_limit::<PairingErrorEnvelope>(response, 1024)
            .await
            .ok()
            .and_then(|body| body.code);
        return Err(pairing_rejection_message(code.as_deref()).into());
    }
    ensure_success(&response, "pairing")?;
    Ok(response)
}

fn pairing_rejection_message(code: Option<&str>) -> &'static str {
    match code {
        Some("invalid_device_name") => {
            "The device name is invalid. Use 1–80 characters without line breaks."
        }
        Some("invalid_device_platform" | "invalid_device_version" | "invalid_app_version") => {
            "The server rejected this device's system details. Update HomePlace Desktop and try again."
        }
        Some("invalid_public_key") => {
            "The server rejected this device's public key. Restart HomePlace Desktop and try again."
        }
        Some("invalid_protocol" | "invalid_capabilities" | "invalid_permissions") => {
            "HomePlace Desktop and the server use different Link features. Update the server and try again."
        }
        _ => {
            "The server rejected the pairing request. Check the device name and update the server if needed."
        }
    }
}

pub(crate) async fn read_bounded_json<T: DeserializeOwned>(
    response: Response,
) -> Result<T, String> {
    read_bounded_json_with_limit(response, MAX_RESPONSE_BYTES).await
}

pub(crate) async fn read_bounded_json_with_limit<T: DeserializeOwned>(
    response: Response,
    limit: usize,
) -> Result<T, String> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("The Link API response is larger than allowed.".into());
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The Link API response could not be read.".to_string())?;
        if body.len().saturating_add(chunk.len()) > limit {
            return Err("The Link API response is larger than allowed.".into());
        }
        body.extend_from_slice(&chunk);
    }

    serde_json::from_slice(&body)
        .map_err(|_| "The server returned an invalid Link API response.".to_string())
}

pub(crate) fn validate_address(input: &str) -> Result<(Url, bool), String> {
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

fn file_transfer_connection_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The HomePlace file transfer did not finish within 30 minutes.".into()
    } else if error.is_connect() {
        "Could not connect to the HomePlace server for file transfer.".into()
    } else {
        "The HomePlace file transfer failed.".into()
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
    #[test]
    fn plant_photo_validation_rejects_mismatched_or_unsupported_files() {
        assert_eq!(
            super::plant_photo_mime(&[0xff, 0xd8, 0xff, 0xe0]),
            Some("image/jpeg")
        );
        assert_eq!(
            super::plant_photo_mime(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(
            super::plant_photo_mime(b"RIFF1234WEBPVP8 "),
            Some("image/webp")
        );
        assert_eq!(super::plant_photo_mime(b"not an image"), None);
    }

    #[test]
    fn plant_photo_cache_is_scoped_and_versioned() {
        let first = super::plant_photo_cache_name("server-a", "device-a", "plant-a", "one");
        assert_ne!(
            first,
            super::plant_photo_cache_name("server-a", "device-b", "plant-a", "one")
        );
        assert_ne!(
            first,
            super::plant_photo_cache_name("server-a", "device-a", "plant-a", "two")
        );
    }

    #[test]
    fn plant_photo_cache_requires_matching_server_version() {
        assert!(super::plant_photo_etag_matches(
            Some("\"photo-a\""),
            "photo-a"
        ));
        assert!(!super::plant_photo_etag_matches(
            Some("\"photo-b\""),
            "photo-a"
        ));
        assert!(!super::plant_photo_etag_matches(None, "photo-a"));
    }
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
        assert!(bounded_device_name(&"😀".repeat(41)).is_err());
        assert!(bounded_device_name("Office\nMac").is_err());
        assert!(!safe_identifier("../pairing"));
    }

    #[test]
    fn pairing_errors_are_actionable_without_echoing_server_input() {
        assert!(pairing_rejection_message(Some("invalid_device_name")).contains("device name"));
        assert!(
            pairing_rejection_message(Some("invalid_permissions")).contains("Update the server")
        );
        assert!(
            pairing_rejection_message(Some("untrusted server text"))
                .contains("rejected the pairing request")
        );
    }

    #[test]
    fn validates_heartbeat_identity_and_events() {
        let profile = StoredProfile {
            server_id: "e54f9bfa-2543-4be2-bc07-c1eb3d0947ee".into(),
            server_name: "HomePlace".into(),
            address: "https://home.example.net".into(),
            device_id: "device_123".into(),
            device_name: "Studio Mac".into(),
            file_batch_approved: false,
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
        let content = notification_content(&notification_event(serde_json::json!({
            "title": "HomePlace",
            "body": "Message",
            "url": "/events",
            "tag": "item-server",
            "urgent": true
        })))
        .unwrap();
        assert_eq!(content.title, "HomePlace");
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
    fn groups_identical_nearby_notifications_and_acknowledges_every_event() {
        let mut first = notification_event(serde_json::json!({
            "title": "HomePlace",
            "body": "Service is unavailable"
        }));
        first.id = "notification_one".into();
        let mut second = notification_event(serde_json::json!({
            "title": "HomePlace",
            "body": "Service is unavailable"
        }));
        second.id = "notification_two".into();

        let mut delivered_title = String::new();
        let (acknowledged, delivered, failures) =
            deliver_notifications(&[first, second], |notification| {
                delivered_title = notification.title.clone();
                Ok(())
            });

        assert_eq!(acknowledged, vec!["notification_one", "notification_two"]);
        assert_eq!(delivered, 1);
        assert_eq!(failures, 0);
        assert_eq!(delivered_title, "HomePlace ×2");
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
    fn describes_incoming_files_in_system_notifications() {
        let event = share_event(
            "share.offer",
            serde_json::json!({
                "type": "file",
                "transferId": "transfer_123",
                "filename": "HomePlace.apk",
                "mimeType": "application/vnd.android.package-archive",
                "size": 1024,
                "sha256": "a".repeat(64),
                "sourceName": "Android phone"
            }),
        );
        let offer = pending_share_offer(&event, "server").unwrap();
        let (title, body) = share_offer_notification(&offer);

        assert_eq!(title, "HomePlace Link · Incoming file");
        assert!(body.contains("HomePlace.apk"));
        assert!(body.contains("Android phone"));
        assert!(body.contains("Open HomePlace"));
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
                "mimeType": "application/octet-stream", "size": MAX_SUPPORTED_FILE_BYTES + 1,
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
        assert!(validate_reminder_title(&"a".repeat(201)).is_err());
        assert!(valid_received_reminder_title(&"a".repeat(500)));
        assert!(!valid_received_reminder_title(&"a".repeat(2_001)));
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
    fn completed_reminders_keep_legacy_entries_without_completion_dates() {
        let at = "2026-09-20T08:00:00.000Z".to_string();
        let reminders = vec![
            OverviewReminderSummary {
                id: "legacy_reminder".into(),
                title: "Old task".into(),
                at: at.clone(),
                repeat: "none".into(),
                done: true,
                completed_at: None,
            },
            OverviewReminderSummary {
                id: "recent_reminder".into(),
                title: "Recent task".into(),
                at,
                repeat: "none".into(),
                done: true,
                completed_at: Some("2026-09-21T08:00:00.000Z".into()),
            },
        ];
        let result = normalize_completed_reminders(ReminderHistoryEnvelope { reminders }).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "recent_reminder");
        assert_eq!(result[1].id, "legacy_reminder");
        assert_eq!(result[1].completed_at, None);
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
