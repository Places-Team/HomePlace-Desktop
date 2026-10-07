use std::{
    collections::HashMap,
    future::Future,
    sync::{LazyLock, Mutex},
};
use tokio::sync::watch;

static SENDS: LazyLock<Mutex<HashMap<String, watch::Sender<bool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[tauri::command]
pub fn begin_share_send(operation_id: String) -> Result<(), String> {
    if operation_id.is_empty()
        || operation_id.len() > 160
        || !operation_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid transfer operation.".into());
    }
    let mut sends = SENDS.lock().map_err(|_| "Could not prepare transfer.")?;
    if sends.len() >= 32 || sends.contains_key(&operation_id) {
        return Err("Transfer already active.".into());
    }
    sends.insert(operation_id, watch::channel(false).0);
    Ok(())
}

#[tauri::command]
pub fn cancel_share_send(operation_id: String) -> Result<bool, String> {
    let sends = SENDS.lock().map_err(|_| "Could not cancel transfer.")?;
    if let Some(signal) = sends.get(&operation_id) {
        signal.send_replace(true);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub fn finish_share_send(operation_id: String) -> Result<(), String> {
    SENDS
        .lock()
        .map_err(|_| "Could not finish transfer.")?
        .remove(&operation_id);
    Ok(())
}

pub async fn run<T>(id: &str, work: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    let mut signal = SENDS
        .lock()
        .map_err(|_| "Could not read transfer.")?
        .get(id)
        .ok_or("Transfer operation is no longer active.")?
        .subscribe();
    if *signal.borrow() {
        return Err("The transfer was cancelled.".into());
    }
    tokio::select! {
        biased;
        _ = signal.changed() => Err("The transfer was cancelled.".into()),
        result = work => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_interrupts_pending_work() {
        let id = "cancel-test".to_string();
        begin_share_send(id.clone()).unwrap();
        assert!(cancel_share_send(id.clone()).unwrap());
        let result = run(&id, std::future::pending::<Result<(), String>>()).await;
        assert_eq!(result.unwrap_err(), "The transfer was cancelled.");
        finish_share_send(id.clone()).unwrap();
        assert!(!cancel_share_send(id).unwrap());
    }

    #[tokio::test]
    async fn completed_work_is_not_undone_by_cancel() {
        let id = "completed-test".to_string();
        begin_share_send(id.clone()).unwrap();
        assert_eq!(run(&id, async { Ok::<_, String>(42) }).await.unwrap(), 42);
        finish_share_send(id.clone()).unwrap();
        assert!(!cancel_share_send(id).unwrap());
    }

    #[tokio::test]
    async fn cancellation_drops_in_flight_work() {
        struct DropNotice(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for DropNotice {
            fn drop(&mut self) {
                if let Some(sender) = self.0.take() {
                    let _ = sender.send(());
                }
            }
        }
        let id = "in-flight-test".to_string();
        begin_share_send(id.clone()).unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (dropped, observed) = tokio::sync::oneshot::channel();
        let task_id = id.clone();
        let task = tokio::spawn(async move {
            run(&task_id, async {
                let _notice = DropNotice(Some(dropped));
                let _ = started.send(());
                std::future::pending::<Result<(), String>>().await
            })
            .await
        });
        ready.await.unwrap();
        cancel_share_send(id.clone()).unwrap();
        assert!(task.await.unwrap().is_err());
        observed.await.unwrap();
        finish_share_send(id).unwrap();
    }
}
