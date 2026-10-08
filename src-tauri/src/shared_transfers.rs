use serde::{Deserialize, Serialize};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub file_name: String,
    pub transferred_bytes: u64,
    pub total_bytes: u64,
    pub file_index: usize,
    pub file_count: usize,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Sending,
    Sent,
    Failed,
    Cancelled,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    id: String,
    target_name: String,
    names: Vec<String>,
    status: Status,
    progress: Option<Progress>,
    error: Option<String>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    transfers: Vec<Transfer>,
}

static STATE: LazyLock<Mutex<Snapshot>> = LazyLock::new(|| Mutex::new(Snapshot::default()));

impl Snapshot {
    fn start(&mut self, id: String, target_name: String, names: Vec<String>) -> Result<(), String> {
        if self
            .transfers
            .iter()
            .any(|item| item.status == Status::Sending)
        {
            return Err("A transfer is already active. Wait for it or cancel it.".into());
        }
        if self.transfers.iter().any(|item| item.id == id) {
            return Err("This transfer already exists.".into());
        }
        if target_name.is_empty()
            || target_name.len() > 512
            || names.is_empty()
            || names.len() > 20
            || names
                .iter()
                .any(|name| name.is_empty() || name.len() > 1024)
        {
            return Err("Invalid transfer details.".into());
        }
        crate::share_send::begin_share_send(id.clone())?;
        self.transfers.insert(
            0,
            Transfer {
                id,
                target_name,
                names,
                status: Status::Sending,
                progress: None,
                error: None,
            },
        );
        self.transfers.truncate(20);
        self.revision += 1;
        Ok(())
    }

    fn update(
        &mut self,
        id: &str,
        status: Status,
        progress: Option<Progress>,
        error: Option<String>,
    ) -> Result<(), String> {
        let item = self
            .transfers
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or("Unknown transfer.")?;
        // Late progress callbacks must not resurrect a finished transfer.
        if item.status != Status::Sending {
            return Ok(());
        }
        if let Some(progress) = &progress
            && (progress.file_count == 0
                || progress.file_count > 20
                || progress.file_index >= progress.file_count
                || progress.file_name.len() > 1024)
        {
            return Err("Invalid transfer progress.".into());
        }
        item.status = status;
        if progress.is_some() {
            item.progress = progress;
        }
        item.error = error.map(|value| value.chars().take(500).collect());
        self.revision += 1;
        Ok(())
    }
}

#[tauri::command]
pub fn shared_transfers() -> Result<Snapshot, String> {
    STATE
        .lock()
        .map(|state| state.clone())
        .map_err(|_| "Could not read transfers.".into())
}

#[tauri::command]
pub fn start_shared_transfer(
    app: AppHandle,
    id: String,
    target_name: String,
    names: Vec<String>,
) -> Result<(), String> {
    let snapshot = {
        let mut state = STATE.lock().map_err(|_| "Could not start transfer.")?;
        state.start(id, target_name, names)?;
        state.clone()
    };
    let _ = app.emit("shared-transfers-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub fn update_shared_transfer(
    app: AppHandle,
    id: String,
    status: Status,
    progress: Option<Progress>,
    error: Option<String>,
) -> Result<(), String> {
    let finished = status != Status::Sending;
    let snapshot = {
        let mut state = STATE.lock().map_err(|_| "Could not update transfer.")?;
        let revision = state.revision;
        state.update(&id, status, progress, error)?;
        if state.revision == revision {
            return Ok(());
        }
        if finished {
            crate::share_send::finish_share_send(id)?;
        }
        state.clone()
    };
    let percent = if finished {
        None
    } else {
        snapshot
            .transfers
            .iter()
            .find(|item| item.status == Status::Sending)
            .map(|item| {
                item.progress.as_ref().map_or(0, |progress| {
                    let fraction = if progress.total_bytes == 0 {
                        0.0
                    } else {
                        (progress.transferred_bytes as f64 / progress.total_bytes as f64)
                            .clamp(0.0, 1.0)
                    };
                    (((progress.file_index as f64 + fraction) / progress.file_count as f64) * 100.0)
                        .round()
                        .clamp(0.0, 100.0) as u8
                })
            })
    };
    let _ = crate::tray::set_share_send_progress(app.clone(), percent);
    let _ = app.emit("shared-transfers-changed", snapshot);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_sender_across_windows_and_late_progress_cannot_revive_it() {
        let mut state = Snapshot::default();
        state
            .start(
                "shared-state-test".into(),
                "Mac".into(),
                vec!["file.txt".into()],
            )
            .unwrap();
        assert!(
            state
                .start(
                    "other-window-test".into(),
                    "PC".into(),
                    vec!["other.txt".into()]
                )
                .is_err()
        );
        state
            .update("shared-state-test", Status::Sent, None, None)
            .unwrap();
        let revision = state.revision;
        state
            .update("shared-state-test", Status::Sending, None, None)
            .unwrap();
        assert_eq!(state.revision, revision);
        assert!(state.transfers[0].status == Status::Sent);
        crate::share_send::finish_share_send("shared-state-test".into()).unwrap();
    }
}
