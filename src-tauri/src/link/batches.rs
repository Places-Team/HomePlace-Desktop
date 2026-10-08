use futures_util::StreamExt;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    io,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::Emitter;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use zeroize::Zeroizing;

use super::{
    client,
    identity::{self, StoredProfile},
};

const MAX_BATCH_FILES: usize = 100;
const MAX_BATCH_STATE_BYTES: u64 = 256 * 1024;
static STATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFile {
    id: String,
    filename: String,
    mime_type: String,
    size: u64,
    sha256: String,
    uploaded_bytes: u64,
    #[serde(default)]
    received: bool,
    upload_id: Option<String>,
    download_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchInfo {
    id: String,
    status: String,
    source_device_id: String,
    target_device_id: String,
    expires_at: String,
    files: Vec<BatchFile>,
}

#[derive(Deserialize)]
struct BatchEnvelope {
    batch: BatchInfo,
}

#[derive(Deserialize)]
struct BatchList {
    batches: Vec<BatchInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadSession {
    id: String,
    offset: u64,
    chunk_bytes: u64,
}

#[derive(Deserialize)]
struct UploadOffset {
    offset: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinishedUpload {
    batch_id: String,
    sha256: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalBatch {
    server_id: String,
    request_key: String,
    batch_id: Option<String>,
    target_device_id: String,
    paths: Vec<PathBuf>,
    destination: Option<PathBuf>,
    #[serde(default)]
    saved_files: std::collections::HashMap<String, PathBuf>,
    #[serde(default)]
    complete: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBatchSummary {
    request_key: String,
    batch_id: Option<String>,
    target_device_id: String,
    file_count: usize,
    sending: bool,
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "HomePlace data directory unavailable.".to_string())?;
    std::fs::create_dir_all(&directory)
        .map_err(|_| "Could not create HomePlace data directory.".to_string())?;
    Ok(directory.join("link-batches.json"))
}

fn read_local(app: &AppHandle) -> Result<Vec<LocalBatch>, String> {
    let path = state_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let size = std::fs::metadata(&path)
        .map_err(|_| "Could not read batch state.".to_string())?
        .len();
    if size > MAX_BATCH_STATE_BYTES {
        return Err("Batch state is too large.".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "Could not read batch state.".to_string())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "Stored batch state is invalid; it was not overwritten.".to_string())
}

fn write_local(app: &AppHandle, records: &[LocalBatch]) -> Result<(), String> {
    let path = state_path(app)?;
    let bytes =
        serde_json::to_vec(records).map_err(|_| "Could not encode batch state.".to_string())?;
    if bytes.len() as u64 > MAX_BATCH_STATE_BYTES {
        return Err("Too many local batch records.".into());
    }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        io::Write::write_all(&mut file, &bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|_| "Could not save batch recovery state.".into())
}

fn update_local(app: &AppHandle, record: LocalBatch) -> Result<(), String> {
    let _guard = STATE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Batch state is busy.".to_string())?;
    let mut records = read_local(app)?;
    if let Some(existing) = records
        .iter_mut()
        .find(|item| item.server_id == record.server_id && item.request_key == record.request_key)
    {
        *existing = record;
    } else {
        records.push(record);
    }
    write_local(app, &records)
}

fn active_profile() -> Result<(StoredProfile, Zeroizing<String>), String> {
    let profile = identity::load_profile()?
        .ok_or_else(|| "Pair HomePlace before using file batches.".to_string())?;
    client::validate_stored_profile(&profile)?;
    let credential = identity::load_credential(&profile.server_id)?;
    Ok((profile, credential))
}

async fn ready_server(profile: &StoredProfile) -> Result<url::Url, String> {
    let verified = client::verify_server(profile.address.clone()).await?;
    if verified.server_id != profile.server_id {
        return Err("The paired server identity changed.".into());
    }
    if !verified.file_batches {
        return Err("This HomePlace server has not enabled file batches yet.".into());
    }
    Ok(client::validate_address(&profile.address)?.0)
}

async fn json_response<T: DeserializeOwned>(
    response: reqwest::Response,
    operation: &str,
) -> Result<T, String> {
    client::ensure_success(&response, operation)?;
    client::read_bounded_json(response).await
}

async fn get_batch(base: &url::Url, credential: &str, id: &str) -> Result<BatchInfo, String> {
    if !safe_id(id) {
        return Err("Invalid batch identifier.".into());
    }
    let endpoint = base
        .join(&format!("api/link/mobile/share/batches/{id}"))
        .map_err(|_| "Invalid batch address.".to_string())?;
    let response = client::file_transfer_client()?
        .get(endpoint)
        .bearer_auth(credential)
        .send()
        .await
        .map_err(|_| "Could not load file batch.".to_string())?;
    let envelope: BatchEnvelope = json_response(response, "batch details").await?;
    validate_batch(&envelope.batch)?;
    Ok(envelope.batch)
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn validate_batch(batch: &BatchInfo) -> Result<(), String> {
    if !safe_id(&batch.id)
        || !safe_id(&batch.source_device_id)
        || !safe_id(&batch.target_device_id)
        || !matches!(
            batch.status.as_str(),
            "assembling" | "offered" | "accepted" | "completed" | "rejected" | "canceled"
        )
        || batch.files.is_empty()
        || batch.files.len() > MAX_BATCH_FILES
    {
        return Err("Invalid batch manifest.".into());
    }
    let mut ids = std::collections::HashSet::new();
    let mut names = std::collections::HashSet::new();
    for file in &batch.files {
        if !safe_id(&file.id)
            || !ids.insert(&file.id)
            || !safe_batch_name(&file.filename)
            || !names.insert(file.filename.to_lowercase())
            || file.size == 0
            || file.size > 10 * 1024 * 1024 * 1024
            || file.sha256.len() != 64
            || !file
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || file.mime_type.is_empty()
            || file.mime_type.len() > 120
        {
            return Err("Invalid batch file manifest.".into());
        }
        if let Some(url) = &file.download_url
            && !url
                .strip_prefix("/api/link/mobile/share/file/")
                .is_some_and(safe_id)
        {
            return Err("Invalid batch download address.".into());
        }
    }
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchTransferProgress {
    batch_id: String,
    file_name: String,
    file_index: usize,
    file_count: usize,
    transferred_bytes: u64,
    total_bytes: u64,
}

async fn fingerprint(path: &Path) -> Result<(u64, String), String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|_| "A selected file is unavailable.".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 10 * 1024 * 1024 * 1024 {
        return Err("Batch files must be nonempty regular files below 10 GiB.".into());
    }
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| "A selected file cannot be opened.".to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut count = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|_| "A selected file cannot be read.".to_string())?;
        if read == 0 {
            break;
        }
        count += read as u64;
        if count > metadata.len() {
            return Err("A selected file changed during verification.".into());
        }
        hasher.update(&buffer[..read]);
    }
    if count != metadata.len() {
        return Err("A selected file changed during verification.".into());
    }
    Ok((count, format!("{:x}", hasher.finalize())))
}

#[tauri::command]
pub async fn send_share_batch(
    app: AppHandle,
    target_device_id: String,
    file_paths: Vec<String>,
    operation_id: Option<String>,
) -> Result<BatchInfo, String> {
    let work = send_share_batch_impl(app, target_device_id, file_paths);
    if let Some(id) = operation_id {
        crate::share_send::run(&id, work).await
    } else {
        work.await
    }
}

async fn send_share_batch_impl(
    app: AppHandle,
    target_device_id: String,
    file_paths: Vec<String>,
) -> Result<BatchInfo, String> {
    if !safe_id(&target_device_id) || file_paths.is_empty() || file_paths.len() > MAX_BATCH_FILES {
        return Err("Choose between 1 and 100 files and a valid recipient.".into());
    }
    let (profile, credential) = active_profile()?;
    let base = ready_server(&profile).await?;
    let limit = client::get_file_transfer_limit().await?;
    let paths: Vec<PathBuf> = file_paths.into_iter().map(PathBuf::from).collect();
    let mut files = Vec::new();
    for path in &paths {
        let filename = path
            .file_name()
            .and_then(|part| part.to_str())
            .ok_or_else(|| "A selected filename is invalid.".to_string())?;
        if !safe_batch_name(filename) {
            return Err("A selected filename is not portable.".into());
        }
        let (size, sha256) = fingerprint(path).await?;
        if size > limit {
            return Err(format!(
                "A file exceeds the HomePlace limit of {limit} bytes."
            ));
        }
        files.push(serde_json::json!({"filename": filename, "mimeType": "application/octet-stream", "size": size, "sha256": sha256}));
    }
    let prior = read_local(&app)?.into_iter().find(|item| {
        item.server_id == profile.server_id
            && item.target_device_id == target_device_id
            && item.paths == paths
            && !item.complete
    });
    let mut record = prior.unwrap_or(LocalBatch {
        server_id: profile.server_id.clone(),
        request_key: uuid::Uuid::new_v4().to_string(),
        batch_id: None,
        target_device_id: target_device_id.clone(),
        paths,
        destination: None,
        saved_files: Default::default(),
        complete: false,
    });
    update_local(&app, record.clone())?;
    let endpoint = base
        .join("api/link/mobile/share/batches")
        .map_err(|_| "Invalid batch API address.".to_string())?;
    let response = client::file_transfer_client()?.post(endpoint).bearer_auth(credential.as_str())
        .json(&serde_json::json!({"targetDeviceId": target_device_id, "requestKey": record.request_key, "files": files}))
        .send().await.map_err(|_| "Could not create file batch; retry with the same local batch.".to_string())?;
    let envelope: BatchEnvelope = json_response(response, "batch creation").await?;
    validate_batch(&envelope.batch)?;
    if envelope.batch.target_device_id != target_device_id
        || envelope.batch.files.len() != record.paths.len()
    {
        return Err("The server returned a different batch manifest.".into());
    }
    record.batch_id = Some(envelope.batch.id.clone());
    update_local(&app, record.clone())?;
    upload_and_publish(&app, &base, credential.as_str(), &mut record).await
}

#[tauri::command]
pub async fn resume_share_batch(app: AppHandle, request_key: String) -> Result<BatchInfo, String> {
    if !safe_id(&request_key) {
        return Err("Invalid local batch key.".into());
    }
    let (profile, credential) = active_profile()?;
    let base = ready_server(&profile).await?;
    let mut record = read_local(&app)?
        .into_iter()
        .find(|item| {
            item.server_id == profile.server_id && item.request_key == request_key && !item.complete
        })
        .ok_or_else(|| "No unfinished local batch found.".to_string())?;
    let batch = if let Some(batch_id) = &record.batch_id {
        get_batch(&base, credential.as_str(), batch_id).await?
    } else {
        let limit = client::get_file_transfer_limit().await?;
        let mut files = Vec::new();
        for path in &record.paths {
            let filename = path
                .file_name()
                .and_then(|part| part.to_str())
                .ok_or_else(|| "A source filename is invalid.".to_string())?;
            if !safe_batch_name(filename) {
                return Err("A source filename is not portable.".into());
            }
            let (size, sha256) = fingerprint(path).await?;
            if size > limit {
                return Err("A source file exceeds the current server limit.".into());
            }
            files.push(serde_json::json!({"filename": filename, "mimeType": "application/octet-stream", "size": size, "sha256": sha256}));
        }
        let endpoint = base
            .join("api/link/mobile/share/batches")
            .map_err(|_| "Invalid batch API address.".to_string())?;
        let response = client::file_transfer_client()?.post(endpoint).bearer_auth(credential.as_str())
            .json(&serde_json::json!({"targetDeviceId": record.target_device_id, "requestKey": record.request_key, "files": files}))
            .send().await.map_err(|_| "Could not recover batch creation; retry later.".to_string())?;
        let batch = json_response::<BatchEnvelope>(response, "batch recovery")
            .await?
            .batch;
        validate_batch(&batch)?;
        record.batch_id = Some(batch.id.clone());
        update_local(&app, record.clone())?;
        batch
    };
    if batch.target_device_id != record.target_device_id || batch.files.len() != record.paths.len()
    {
        return Err("Batch recovery manifest changed.".into());
    }
    upload_and_publish(&app, &base, credential.as_str(), &mut record).await
}

#[tauri::command]
pub fn list_local_share_batches(app: AppHandle) -> Result<Vec<LocalBatchSummary>, String> {
    let profile =
        identity::load_profile()?.ok_or_else(|| "No paired HomePlace server.".to_string())?;
    Ok(read_local(&app)?
        .into_iter()
        .filter(|record| {
            record.server_id == profile.server_id
                && !record.complete
                && record.destination.is_none()
                && !record.paths.is_empty()
        })
        .map(|record| LocalBatchSummary {
            request_key: record.request_key,
            batch_id: record.batch_id,
            target_device_id: record.target_device_id,
            file_count: record.paths.len(),
            sending: true,
        })
        .collect())
}

#[tauri::command]
pub fn file_batch_receive_approved() -> Result<bool, String> {
    Ok(identity::load_profile()?.is_some_and(|profile| profile.file_batch_approved))
}

async fn upload_and_publish(
    app: &AppHandle,
    base: &url::Url,
    credential: &str,
    record: &mut LocalBatch,
) -> Result<BatchInfo, String> {
    let id = record
        .batch_id
        .as_ref()
        .ok_or_else(|| "Batch identifier unavailable.".to_string())?
        .clone();
    let mut batch = get_batch(base, credential, &id).await?;
    if batch.status != "assembling" {
        if matches!(batch.status.as_str(), "offered" | "accepted" | "completed") {
            record.complete = true;
            update_local(app, record.clone())?;
            return Ok(batch);
        }
        return Err("This batch can no longer be sent.".into());
    }
    let files = batch.files.clone();
    for (index, manifest) in files.iter().enumerate() {
        let path = &record.paths[index];
        let (size, sha256) = fingerprint(path).await?;
        if size != manifest.size || sha256 != manifest.sha256 {
            return Err("A source file changed after batch creation; cancel this batch and start a new one.".into());
        }
        if manifest.uploaded_bytes == manifest.size {
            continue;
        }
        let endpoint = base
            .join("api/link/mobile/share/uploads")
            .map_err(|_| "Invalid upload API address.".to_string())?;
        let response = client::file_transfer_client()?.post(endpoint).bearer_auth(credential)
            .json(&serde_json::json!({"targetDeviceId": record.target_device_id, "batchFileId": manifest.id,
                "filename": manifest.filename, "mimeType": manifest.mime_type, "size": manifest.size}))
            .send().await.map_err(|_| "Could not begin a batch upload.".to_string())?;
        let session: UploadSession = json_response(response, "batch upload").await?;
        if !safe_id(&session.id)
            || session.offset > manifest.size
            || session.chunk_bytes == 0
            || session.chunk_bytes > 8 * 1024 * 1024
        {
            return Err("The server returned an invalid upload session.".into());
        }
        let mut file = tokio::fs::File::open(path)
            .await
            .map_err(|_| "Could not reopen a batch file.".to_string())?;
        file.seek(std::io::SeekFrom::Start(session.offset))
            .await
            .map_err(|_| "Could not resume the batch file.".to_string())?;
        let mut offset = session.offset;
        let upload_url = base
            .join(&format!("api/link/mobile/share/uploads/{}", session.id))
            .map_err(|_| "Invalid upload address.".to_string())?;
        let mut buffer = vec![0_u8; session.chunk_bytes as usize];
        while offset < manifest.size {
            let amount = (manifest.size - offset).min(buffer.len() as u64) as usize;
            file.read_exact(&mut buffer[..amount])
                .await
                .map_err(|_| "Batch file changed during upload.".to_string())?;
            let response = client::file_transfer_client()?
                .patch(upload_url.clone())
                .bearer_auth(credential)
                .header("x-upload-offset", offset.to_string())
                .header(reqwest::header::CONTENT_LENGTH, amount)
                .body(buffer[..amount].to_vec())
                .send()
                .await
                .map_err(|_| "Batch upload interrupted; resume to retry.".to_string())?;
            let acknowledged: UploadOffset = json_response(response, "batch chunk").await?;
            if acknowledged.offset != offset + amount as u64 {
                return Err(
                    "The server acknowledged a different upload offset; resume this batch.".into(),
                );
            }
            offset = acknowledged.offset;
            let _ = app.emit(
                "link-file-batch-send-progress",
                BatchTransferProgress {
                    batch_id: id.clone(),
                    file_name: manifest.filename.clone(),
                    file_index: index + 1,
                    file_count: batch.files.len(),
                    transferred_bytes: offset,
                    total_bytes: manifest.size,
                },
            );
        }
        let response = client::file_transfer_client()?
            .post(upload_url)
            .bearer_auth(credential)
            .send()
            .await
            .map_err(|_| "Could not finalize batch file; resume to retry.".to_string())?;
        let finished: FinishedUpload = json_response(response, "batch file finalization").await?;
        if finished.batch_id != id || finished.sha256 != manifest.sha256 {
            return Err("The finalized file does not match the batch manifest.".into());
        }
    }
    let endpoint = base
        .join(&format!("api/link/mobile/share/batches/{id}"))
        .map_err(|_| "Invalid batch API address.".to_string())?;
    let response = client::file_transfer_client()?
        .post(endpoint)
        .bearer_auth(credential)
        .json(&serde_json::json!({"action": "publish"}))
        .send()
        .await
        .map_err(|_| "Could not publish batch; resume to retry.".to_string())?;
    batch = json_response::<BatchEnvelope>(response, "batch publication")
        .await?
        .batch;
    validate_batch(&batch)?;
    record.complete = true;
    update_local(app, record.clone())?;
    Ok(batch)
}

#[tauri::command]
pub async fn list_share_batches(app: AppHandle) -> Result<Vec<BatchInfo>, String> {
    let (profile, credential) = active_profile()?;
    let base = match ready_server(&profile).await {
        Ok(base) => base,
        Err(message) if message.contains("not enabled file batches") => return Ok(Vec::new()),
        Err(message) => return Err(message),
    };
    let endpoint = base
        .join("api/link/mobile/share/batches")
        .map_err(|_| "Invalid batch list address.".to_string())?;
    let response = client::file_transfer_client()?
        .get(endpoint)
        .bearer_auth(credential.as_str())
        .send()
        .await
        .map_err(|_| "Could not load file batches.".to_string())?;
    client::ensure_success(&response, "batch list")?;
    let envelope: BatchList =
        client::read_bounded_json_with_limit(response, 2 * 1024 * 1024).await?;
    if envelope.batches.len() > 50 {
        return Err("The server returned too many batches.".into());
    }
    let mut incoming = Vec::new();
    for batch in envelope.batches {
        validate_batch(&batch)?;
        if batch.target_device_id != profile.device_id {
            continue;
        }
        if batch.status == "offered" {
            let already_seen = read_local(&app)?.iter().any(|item| {
                item.server_id == profile.server_id && item.batch_id.as_deref() == Some(&batch.id)
            });
            if !already_seen {
                crate::tray::show_quick_share_incoming(&app);
                update_local(
                    &app,
                    LocalBatch {
                        server_id: profile.server_id.clone(),
                        request_key: batch.id.clone(),
                        batch_id: Some(batch.id.clone()),
                        target_device_id: profile.device_id.clone(),
                        paths: Vec::new(),
                        destination: None,
                        saved_files: Default::default(),
                        complete: false,
                    },
                )?;
                if identity::system_notifications_enabled(&profile.server_id).unwrap_or(false) {
                    let _ = app
                        .notification()
                        .builder()
                        .title("HomePlace Link · Incoming files")
                        .body(format!(
                            "{} files are waiting for your approval.",
                            batch.files.len()
                        ))
                        .show();
                }
            }
        }
        if matches!(batch.status.as_str(), "offered" | "accepted" | "completed") {
            incoming.push(batch);
        }
    }
    Ok(incoming)
}

async fn batch_action(
    base: &url::Url,
    credential: &str,
    id: &str,
    value: serde_json::Value,
) -> Result<BatchInfo, String> {
    if !safe_id(id) {
        return Err("Invalid batch identifier.".into());
    }
    let endpoint = base
        .join(&format!("api/link/mobile/share/batches/{id}"))
        .map_err(|_| "Invalid batch action address.".to_string())?;
    let response = client::file_transfer_client()?
        .post(endpoint)
        .bearer_auth(credential)
        .json(&value)
        .send()
        .await
        .map_err(|_| "Could not update the file batch; retry later.".to_string())?;
    let batch = json_response::<BatchEnvelope>(response, "batch action")
        .await?
        .batch;
    validate_batch(&batch)?;
    Ok(batch)
}

#[tauri::command]
pub async fn reject_share_batch(app: AppHandle, batch_id: String) -> Result<(), String> {
    let (profile, credential) = active_profile()?;
    let base = ready_server(&profile).await?;
    let batch = get_batch(&base, credential.as_str(), &batch_id).await?;
    if batch.target_device_id != profile.device_id || batch.status != "offered" {
        return Err("The batch is not awaiting this device's approval.".into());
    }
    let changed = batch_action(
        &base,
        credential.as_str(),
        &batch_id,
        serde_json::json!({"action": "reject"}),
    )
    .await?;
    if changed.status != "rejected" {
        return Err("The batch was not rejected.".into());
    }
    let _ = app;
    Ok(())
}

#[tauri::command]
pub async fn accept_share_batch(app: AppHandle, batch_id: String) -> Result<BatchInfo, String> {
    let (profile, credential) = active_profile()?;
    let base = ready_server(&profile).await?;
    let batch = get_batch(&base, credential.as_str(), &batch_id).await?;
    if batch.target_device_id != profile.device_id
        || !matches!(batch.status.as_str(), "offered" | "accepted" | "completed")
    {
        return Err("The batch is not available to this device.".into());
    }
    let selected = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .ok_or_else(|| "No destination folder selected; batch remains pending.".to_string())?;
    let directory = selected
        .into_path()
        .map_err(|_| "The selected folder is unavailable.".to_string())?;
    let directory = std::fs::canonicalize(directory)
        .map_err(|_| "The selected folder is unavailable.".to_string())?;
    if !directory.is_dir() {
        return Err("Choose a folder for the entire batch.".into());
    }
    let mut record = LocalBatch {
        server_id: profile.server_id.clone(),
        request_key: batch_id.clone(),
        batch_id: Some(batch_id.clone()),
        target_device_id: profile.device_id.clone(),
        paths: Vec::new(),
        destination: Some(directory),
        saved_files: Default::default(),
        complete: false,
    };
    update_local(&app, record.clone())?;
    let accepted = if batch.status == "offered" {
        batch_action(
            &base,
            credential.as_str(),
            &batch_id,
            serde_json::json!({"action": "accept"}),
        )
        .await?
    } else {
        batch
    };
    if accepted.status != "accepted" && accepted.status != "completed" {
        return Err("The batch was not accepted.".into());
    }
    receive_files(&app, &base, credential.as_str(), &mut record).await
}

#[tauri::command]
pub async fn resume_received_batch(app: AppHandle, batch_id: String) -> Result<BatchInfo, String> {
    if !safe_id(&batch_id) {
        return Err("Invalid batch identifier.".into());
    }
    let (profile, credential) = active_profile()?;
    let base = ready_server(&profile).await?;
    let mut record = read_local(&app)?
        .into_iter()
        .find(|item| {
            item.server_id == profile.server_id
                && item.batch_id.as_deref() == Some(&batch_id)
                && item.target_device_id == profile.device_id
                && item.destination.is_some()
        })
        .ok_or_else(|| {
            "No saved folder or consent for this batch; approve it in HomePlace first.".to_string()
        })?;
    receive_files(&app, &base, credential.as_str(), &mut record).await
}

async fn receive_files(
    app: &AppHandle,
    base: &url::Url,
    credential: &str,
    record: &mut LocalBatch,
) -> Result<BatchInfo, String> {
    let id = record
        .batch_id
        .as_deref()
        .ok_or_else(|| "Batch identifier unavailable.".to_string())?
        .to_owned();
    let mut batch = get_batch(base, credential, &id).await?;
    if !matches!(batch.status.as_str(), "accepted" | "completed") {
        return Err("This batch has not been approved.".into());
    }
    let directory = record
        .destination
        .as_ref()
        .ok_or_else(|| "No saved destination for this batch.".to_string())?
        .clone();
    if !directory.is_dir() {
        return Err("The saved destination folder is unavailable.".into());
    }
    let mut last_progress = std::time::Instant::now();
    let files = batch.files.clone();
    for (index, manifest) in files.iter().enumerate() {
        let saved = record
            .saved_files
            .get(&manifest.id)
            .filter(|path| path.parent() == Some(directory.as_path()))
            .filter(|path| {
                std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file())
            })
            .and_then(|path| {
                find_verified_path(path, manifest.size, &manifest.sha256).then(|| path.clone())
            });
        let destination = if let Some(path) = saved.or_else(|| {
            find_verified_existing(
                &directory,
                &manifest.filename,
                manifest.size,
                &manifest.sha256,
            )
        }) {
            path
        } else {
            download_one(
                app,
                base,
                credential,
                &id,
                index,
                batch.files.len(),
                manifest,
                &directory,
                &mut last_progress,
            )
            .await?
        };
        record.saved_files.insert(manifest.id.clone(), destination);
        update_local(app, record.clone())?;
        batch = batch_action(
            base,
            credential,
            &id,
            serde_json::json!({"action": "received", "fileId": manifest.id,
            "size": manifest.size, "sha256": manifest.sha256}),
        )
        .await?;
    }
    record.complete = batch.status == "completed";
    update_local(app, record.clone())?;
    Ok(batch)
}

fn find_verified_path(path: &Path, size: u64, sha256: &str) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    if file.metadata().map_or(true, |meta| meta.len() != size) {
        return false;
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => hasher.update(&buffer[..count]),
            Err(_) => return false,
        }
    }
    format!("{:x}", hasher.finalize()) == sha256
}

#[allow(clippy::too_many_arguments)]
async fn download_one(
    app: &AppHandle,
    base: &url::Url,
    credential: &str,
    batch_id: &str,
    index: usize,
    file_count: usize,
    manifest: &BatchFile,
    directory: &Path,
    last_progress: &mut std::time::Instant,
) -> Result<PathBuf, String> {
    let relative = manifest
        .download_url
        .as_ref()
        .ok_or_else(|| "The accepted file has no download address.".to_string())?;
    let endpoint = base
        .join(relative)
        .map_err(|_| "Invalid file download address.".to_string())?;
    if endpoint.origin() != base.origin() {
        return Err("File download moved to another server.".into());
    }
    let response = client::file_transfer_client()?
        .get(endpoint)
        .bearer_auth(credential)
        .header(reqwest::header::ACCEPT, "application/octet-stream")
        .send()
        .await
        .map_err(|_| "Could not download a batch file.".to_string())?;
    client::ensure_success(&response, "batch file download")?;
    if response
        .content_length()
        .is_some_and(|length| length != manifest.size)
        || response
            .headers()
            .get("x-homeplace-sha256")
            .and_then(|value| value.to_str().ok())
            != Some(&manifest.sha256)
        || response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            != Some(&manifest.mime_type)
    {
        return Err("The downloaded file headers do not match the approved manifest.".into());
    }
    let temporary = directory.join(format!(
        ".homeplace-{}-{}.part",
        batch_id,
        uuid::Uuid::new_v4()
    ));
    let result = async {
        let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).await.map_err(|_| "Could not create a temporary batch file.".to_string())?;
        let mut stream = response.bytes_stream();
        let mut received = 0_u64;
        let mut hasher = Sha256::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "Batch download interrupted; resume to retry.".to_string())?;
            received = received.checked_add(chunk.len() as u64).filter(|count| *count <= manifest.size)
                .ok_or_else(|| "The downloaded file exceeds the approved size.".to_string())?;
            hasher.update(&chunk);
            file.write_all(&chunk).await.map_err(|_| "Could not save a batch file.".to_string())?;
            if last_progress.elapsed() >= std::time::Duration::from_secs(3) {
                let _ = app.emit("link-file-batch-progress", BatchTransferProgress { batch_id: batch_id.to_owned(), file_name: manifest.filename.clone(),
                    file_index: index + 1, file_count, transferred_bytes: received, total_bytes: manifest.size });
                let _ = batch_action(base, credential, batch_id, serde_json::json!({"action": "progress", "fileId": manifest.id, "bytes": received})).await;
                *last_progress = std::time::Instant::now();
            }
        }
        if received != manifest.size || format!("{:x}", hasher.finalize()) != manifest.sha256 { return Err("The downloaded file failed size or SHA-256 verification.".into()); }
        file.flush().await.map_err(|_| "Could not save a batch file.".to_string())?;
        file.sync_all().await.map_err(|_| "Could not make a batch file durable.".to_string())?;
        let _ = app.emit("link-file-batch-progress", BatchTransferProgress { batch_id: batch_id.to_owned(), file_name: manifest.filename.clone(),
            file_index: index + 1, file_count, transferred_bytes: received, total_bytes: manifest.size });
        drop(file);
        publish_verified_temp(&temporary, directory, &manifest.filename).map_err(|_| "Could not publish a verified batch file without overwriting an existing file.".to_string())
    }.await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

fn safe_batch_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    !name.is_empty()
        && name.len() <= 240
        && name != "."
        && name != ".."
        && !name.ends_with(['.', ' '])
        && !name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\' || c == ':')
        && !reserved
}

fn publish_verified_temp(
    temporary: &Path,
    directory: &Path,
    filename: &str,
) -> io::Result<PathBuf> {
    if !safe_batch_name(filename) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid batch filename",
        ));
    }
    let name = Path::new(filename);
    let stem = name
        .file_stem()
        .and_then(|part| part.to_str())
        .unwrap_or(filename);
    let extension = name
        .extension()
        .and_then(|part| part.to_str())
        .map(|part| format!(".{part}"))
        .unwrap_or_default();
    for suffix in 0..1000 {
        let candidate = if suffix == 0 {
            filename.to_owned()
        } else {
            format!("{stem} ({suffix}){extension}")
        };
        let destination = directory.join(candidate);
        match std::fs::hard_link(temporary, &destination) {
            Ok(()) => {
                std::fs::remove_file(temporary)?;
                return Ok(destination);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "no unused batch filename",
    ))
}

fn candidate_name(filename: &str, suffix: usize) -> String {
    if suffix == 0 {
        return filename.to_owned();
    }
    let name = Path::new(filename);
    let stem = name
        .file_stem()
        .and_then(|part| part.to_str())
        .unwrap_or(filename);
    let extension = name
        .extension()
        .and_then(|part| part.to_str())
        .map(|part| format!(".{part}"))
        .unwrap_or_default();
    format!("{stem} ({suffix}){extension}")
}

fn find_verified_existing(
    directory: &Path,
    filename: &str,
    size: u64,
    sha256: &str,
) -> Option<PathBuf> {
    use std::io::Read;
    if !safe_batch_name(filename) {
        return None;
    }
    for suffix in 0..1000 {
        let candidate = directory.join(candidate_name(filename, suffix));
        let metadata = std::fs::symlink_metadata(&candidate).ok();
        if metadata
            .as_ref()
            .is_none_or(|item| !item.file_type().is_file() || item.len() != size)
        {
            continue;
        }
        let Ok(mut file) = std::fs::File::open(&candidate) else {
            continue;
        };
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        while let Ok(read) = file.read(&mut buffer) {
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        if format!("{:x}", hasher.finalize()) == sha256 {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_names_must_be_flat_and_portable() {
        assert!(safe_batch_name("holiday.png"));
        assert!(!safe_batch_name("../holiday.png"));
        assert!(!safe_batch_name("folder/holiday.png"));
        assert!(!safe_batch_name("folder\\holiday.png"));
        assert!(!safe_batch_name("CON.txt"));
    }

    #[test]
    fn verified_file_publication_never_replaces_an_existing_file() {
        let directory =
            std::env::temp_dir().join(format!("homeplace-batch-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("notes.txt"), b"old").unwrap();
        let temporary = directory.join(".incoming.part");
        std::fs::write(&temporary, b"new").unwrap();

        let published = publish_verified_temp(&temporary, &directory, "notes.txt").unwrap();
        assert_eq!(std::fs::read(directory.join("notes.txt")).unwrap(), b"old");
        assert_eq!(std::fs::read(published).unwrap(), b"new");
        assert!(!temporary.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn existing_local_file_is_skipped_only_when_hash_and_size_match() {
        let directory =
            std::env::temp_dir().join(format!("homeplace-batch-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("notes.txt"), b"old").unwrap();
        let digest = format!("{:x}", Sha256::digest(b"new"));
        assert!(find_verified_existing(&directory, "notes.txt", 3, &digest).is_none());
        std::fs::write(directory.join("notes (1).txt"), b"new").unwrap();
        assert_eq!(
            find_verified_existing(&directory, "notes.txt", 3, &digest),
            Some(directory.join("notes (1).txt"))
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn batch_manifest_rejects_duplicate_names_and_external_downloads() {
        let file = BatchFile {
            id: "file-1".into(),
            filename: "notes.txt".into(),
            mime_type: "application/octet-stream".into(),
            size: 3,
            sha256: format!("{:x}", Sha256::digest(b"new")),
            uploaded_bytes: 3,
            received: false,
            upload_id: None,
            download_url: Some("/api/link/mobile/share/file/transfer-1".into()),
        };
        let mut batch = BatchInfo {
            id: "batch-1".into(),
            status: "accepted".into(),
            source_device_id: "source".into(),
            target_device_id: "target".into(),
            expires_at: "2026-10-04T00:00:00Z".into(),
            files: vec![file.clone()],
        };
        assert!(validate_batch(&batch).is_ok());
        batch.files.push(BatchFile {
            id: "file-2".into(),
            filename: "NOTES.TXT".into(),
            ..file.clone()
        });
        assert!(validate_batch(&batch).is_err());
        batch.files.pop();
        batch.files[0].download_url = Some("https://example.com/steal".into());
        assert!(validate_batch(&batch).is_err());
    }
}
