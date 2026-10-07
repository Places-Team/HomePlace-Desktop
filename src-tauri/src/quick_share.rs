use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

struct VisibilityEpoch(AtomicU64);
impl VisibilityEpoch {
    const fn new() -> Self {
        Self(AtomicU64::new(0))
    }
    fn advance(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }
    fn is_current(&self, epoch: u64) -> bool {
        self.0.load(Ordering::SeqCst) == epoch
    }
}
static EPOCH: VisibilityEpoch = VisibilityEpoch::new();
const EXIT_MS: u64 = 120;

fn should_hide_idle_drag(current: bool, retained: bool) -> bool {
    current && !retained
}

pub fn finish_drag<R: Runtime>(app: &AppHandle<R>) {
    let epoch = EPOCH.0.load(Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Allow the WebView drop handler to stage and pin the selection first.
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        let callback_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            if should_hide_idle_drag(EPOCH.is_current(epoch), crate::tray::quick_share_retained()) {
                if let Some(window) = callback_app.get_webview_window("quick-share") {
                    let _ = window.set_ignore_cursor_events(true);
                    let _ = window.hide();
                }
            }
        });
    });
}

pub fn configure<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
    #[cfg(target_os = "macos")]
    if let Ok(pointer) = window.ns_window() {
        // Called on the app's main thread. This is Tauri's existing NSWindow;
        // never replace its class or change application-wide activation policy.
        let native = unsafe { &*pointer.cast::<objc2_app_kit::NSWindow>() };
        native.setOpaque(false);
        use objc2_app_kit::NSAccessibility;
        use objc2_app_kit::NSWindowCollectionBehavior as Behavior;
        let mut behavior = native.collectionBehavior();
        behavior.remove(Behavior::Managed | Behavior::ParticipatesInCycle);
        behavior.insert(Behavior::Transient | Behavior::IgnoresCycle);
        native.setCollectionBehavior(behavior);
        native.setExcludedFromWindowsMenu(true);
        // Assistive tools and third-party switchers should see a floating shelf,
        // not a second document window. Keep the window accessible to readers.
        native.setAccessibilitySubrole(Some(unsafe {
            objc2_app_kit::NSAccessibilityFloatingWindowSubrole
        }));
    }
}

fn delayed_hide<R: Runtime>(app: AppHandle<R>, epoch: u64, delay: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        let callback_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            if !EPOCH.is_current(epoch) {
                return;
            }
            if let Some(window) = callback_app.get_webview_window("quick-share") {
                let _ = window.set_ignore_cursor_events(true);
                let _ = window.hide();
            }
        });
    });
}

/// A transparent, unpainted webview must never become a mouse-catching overlay.
pub fn prepare_show<R: Runtime>(app: &AppHandle<R>) {
    let epoch = EPOCH.advance();
    if let Some(window) = app.get_webview_window("quick-share") {
        let _ = window.set_ignore_cursor_events(true);
    }
    // Hide even if the frontend fails to acknowledge the opened event.
    delayed_hide(app.clone(), epoch, 1000);
}

#[tauri::command]
pub fn set_quick_share_open(window: WebviewWindow, open: bool) -> Result<(), String> {
    if window.label() != "quick-share" {
        return Err("Only Quick Share can use shelf visibility.".into());
    }
    let epoch = EPOCH.advance();
    window
        .set_ignore_cursor_events(!open)
        .map_err(|_| "Could not update Quick Share mouse handling.")?;
    if !open {
        delayed_hide(window.app_handle().clone(), epoch, EXIT_MS);
    }
    Ok(())
}

#[tauri::command]
pub fn focus_quick_share(window: WebviewWindow) -> Result<(), String> {
    if window.label() != "quick-share" {
        return Err("Only Quick Share can focus the shelf.".into());
    }
    window
        .set_focus()
        .map_err(|_| "Could not focus Quick Share.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drag_cleanup_preserves_new_interactions_and_retained_content() {
        assert!(should_hide_idle_drag(true, false));
        assert!(!should_hide_idle_drag(true, true));
        assert!(!should_hide_idle_drag(false, false));
    }
    #[test]
    fn reopening_invalidates_both_pending_hide_and_unpainted_window_timeout() {
        let epoch = VisibilityEpoch::new();
        let unpainted = epoch.advance();
        let ready = epoch.advance();
        assert!(!epoch.is_current(unpainted));
        assert!(epoch.is_current(ready));
        let closing = epoch.advance();
        let reopened = epoch.advance();
        assert!(!epoch.is_current(closing));
        assert!(epoch.is_current(reopened));
    }
}
