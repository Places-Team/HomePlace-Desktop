use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

use tauri::{
    App, AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Rect, Runtime,
    Size,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_notification::NotificationExt;

pub const TRAY_ID: &str = "homeplace";
const PROFILE_CHANGED_EVENT: &str = "link-profile-changed";
static BACKGROUND_NOTICE_SHOWN: AtomicBool = AtomicBool::new(false);
static QUICK_SHARE_POINTER_INSIDE: AtomicBool = AtomicBool::new(false);
static QUICK_SHARE_PINNED: AtomicBool = AtomicBool::new(false);
static QUICK_SHARE_PRESENTATION: AtomicU64 = AtomicU64::new(0);
static LAST_TRAY_RECT: Mutex<Option<Rect>> = Mutex::new(None);

#[derive(Debug, PartialEq, Eq)]
enum TrayCommand {
    QuickShare,
    Show,
    Navigate(&'static str),
    Reconnect,
    Quit,
}

pub enum ConnectionState {
    Connected,
    Interrupted,
    NotConfigured,
}

pub fn install(app: &App) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("HomePlace Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(server_id) = profile_server_id(id) {
                match crate::link::client::activate_stored_profile(server_id) {
                    Ok(_) => {
                        refresh_menu(app);
                        if let Some(service) =
                            app.try_state::<crate::link::client::HeartbeatService>()
                        {
                            service.wake();
                        }
                        let _ = app.emit(PROFILE_CHANGED_EVENT, server_id);
                    }
                    Err(_) => {
                        let _ = app
                            .notification()
                            .builder()
                            .title("HomePlace Desktop")
                            .body("The selected server could not be activated.")
                            .show();
                    }
                }
                return;
            }

            match tray_command(id) {
                Some(TrayCommand::QuickShare) => show_quick_share_near_cursor(app),
                Some(TrayCommand::Show) => show_main_window(app),
                Some(TrayCommand::Navigate(section)) => {
                    show_main_window(app);
                    let _ = app.emit("navigate-section", section);
                }
                Some(TrayCommand::Reconnect) => {
                    if let Some(service) = app.try_state::<crate::link::client::HeartbeatService>()
                    {
                        service.wake();
                    }
                }
                Some(TrayCommand::Quit) => app.exit(0),
                None => {}
            }
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Enter { rect, .. } => {
                remember_tray_rect(rect);
            }
            TrayIconEvent::Move { rect, .. } => {
                remember_tray_rect(rect);
            }
            TrayIconEvent::Click {
                rect,
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                remember_tray_rect(rect.clone());
                show_quick_share(tray.app_handle(), rect, true);
            }
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            TrayIconEvent::Leave { rect, .. } => remember_tray_rect(rect),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn build_menu<R: Runtime, M: Manager<R>>(app: &M) -> tauri::Result<Menu<R>> {
    let quick_share = MenuItem::with_id(app, "quick-share", "Quick Share", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open HomePlace", true, None::<&str>)?;
    let reconnect = MenuItem::with_id(app, "reconnect", "Reconnect now", true, None::<&str>)?;
    let devices = MenuItem::with_id(app, "navigate:devices", "Devices", true, None::<&str>)?;
    let clipboard = MenuItem::with_id(
        app,
        "navigate:clipboard",
        "Clipboard history",
        true,
        None::<&str>,
    )?;
    let transfers = MenuItem::with_id(app, "navigate:transfers", "Transfers", true, None::<&str>)?;
    let productivity = MenuItem::with_id(
        app,
        "navigate:productivity",
        "Productivity",
        true,
        None::<&str>,
    )?;
    let sections = Submenu::with_items(
        app,
        "Open section",
        true,
        &[&devices, &clipboard, &transfers, &productivity],
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit HomePlace", true, None::<&str>)?;

    let profiles = crate::link::identity::load_profiles().unwrap_or_default();
    let active_server_id = crate::link::identity::load_profile()
        .ok()
        .flatten()
        .map(|profile| profile.server_id);
    let mut profile_items = Vec::with_capacity(profiles.len().max(1));
    if profiles.is_empty() {
        profile_items.push(MenuItem::with_id(
            app,
            "profile:none",
            "No paired servers",
            false,
            None::<&str>,
        )?);
    } else {
        for profile in profiles {
            let marker = if active_server_id.as_deref() == Some(&profile.server_id) {
                "✓ "
            } else {
                ""
            };
            let label = format!("{marker}{}", menu_label(&profile.server_name));
            profile_items.push(MenuItem::with_id(
                app,
                format!("profile:{}", profile.server_id),
                label,
                true,
                None::<&str>,
            )?);
        }
    }
    let profile_refs: Vec<&dyn IsMenuItem<R>> = profile_items
        .iter()
        .map(|item| item as &dyn IsMenuItem<R>)
        .collect();
    let servers = Submenu::with_items(app, "Servers", true, &profile_refs)?;

    Menu::with_items(
        app,
        &[
            &quick_share,
            &open,
            &sections,
            &servers,
            &reconnect,
            &separator,
            &quit,
        ],
    )
}

fn show_quick_share_near_cursor<R: Runtime>(app: &AppHandle<R>) {
    if let Some(rect) = quick_share_anchor(app) {
        show_quick_share(app, rect, true);
        return;
    }
    let Ok(cursor) = app.cursor_position() else {
        return;
    };
    let rect = Rect {
        position: Position::Physical(PhysicalPosition::new(
            cursor.x.round() as i32,
            cursor.y.round() as i32,
        )),
        size: Size::Physical(PhysicalSize::new(1, 1)),
    };
    show_quick_share(app, rect, true);
}

fn remember_tray_rect(rect: Rect) {
    if let Ok(mut stored) = LAST_TRAY_RECT.lock() {
        *stored = Some(rect);
    }
}

fn quick_share_anchor<R: Runtime>(app: &AppHandle<R>) -> Option<Rect> {
    if let Some(rect) = app
        .tray_by_id(TRAY_ID)
        .and_then(|tray| tray.rect().ok().flatten())
    {
        remember_tray_rect(rect.clone());
        return Some(rect);
    }
    if let Ok(stored) = LAST_TRAY_RECT.lock()
        && let Some(rect) = stored.clone()
    {
        return Some(rect);
    }
    let cursor = app.cursor_position().ok()?;
    Some(Rect {
        position: Position::Physical(PhysicalPosition::new(
            cursor.x.round() as i32,
            cursor.y.round() as i32,
        )),
        size: Size::Physical(PhysicalSize::new(1, 1)),
    })
}

pub fn show_quick_share_for_drag<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("quick-share") else {
        return;
    };
    if QUICK_SHARE_PINNED.load(Ordering::Relaxed) {
        if !window.is_visible().unwrap_or(false)
            && let Some(rect) = quick_share_anchor(app)
        {
            show_quick_share(app, rect, false);
        }
        return;
    }
    QUICK_SHARE_POINTER_INSIDE.store(false, Ordering::Relaxed);
    let _ = window.set_size(tauri::LogicalSize::new(104.0, 56.0));
    let _ = app.emit("quick-share-drag-active", true);
    if let Some(rect) = quick_share_anchor(app) {
        show_quick_share(app, rect, false);
    }
}

pub fn finish_quick_share_drag<R: Runtime>(app: &AppHandle<R>) {
    QUICK_SHARE_POINTER_INSIDE.store(false, Ordering::Relaxed);
    let _ = app.emit("quick-share-drag-active", false);
    crate::quick_share::finish_drag(app);
}

pub fn quick_share_retained() -> bool {
    QUICK_SHARE_PINNED.load(Ordering::Relaxed)
}

pub fn quick_share_generation() -> u64 {
    QUICK_SHARE_PRESENTATION.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn set_share_send_progress(app: AppHandle, percent: Option<u8>) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return Ok(()); };
    let Some(base) = app.default_window_icon() else { return Ok(()); };
    if let Some(percent) = percent {
        if percent > 100 { return Err("Invalid transfer progress.".into()); }
        let mut pixels = vec![0_u8; 64 * 64 * 4];
        for y in 0..64_usize {
            for x in 0..64_usize {
                let offset = (y * 64 + x) * 4;
                let dx = x as f64 - 31.5;
                let dy = y as f64 - 31.5;
                let distance = (dx * dx + dy * dy).sqrt();
                if (27.0..=31.0).contains(&distance) {
                    let angle = (dy.atan2(dx) + std::f64::consts::FRAC_PI_2).rem_euclid(std::f64::consts::TAU);
                    let filled = angle / std::f64::consts::TAU <= f64::from(percent) / 100.0;
                    pixels[offset..offset + 4].copy_from_slice(if filled { &[237, 155, 83, 255] } else { &[140, 140, 140, 150] });
                }
                if (14..50).contains(&x) && (14..50).contains(&y) && base.width() > 0 && base.height() > 0 {
                    let sx = (x - 14) * base.width() as usize / 36;
                    let sy = (y - 14) * base.height() as usize / 36;
                    let source = (sy * base.width() as usize + sx) * 4;
                    pixels[offset..offset + 4].copy_from_slice(&base.rgba()[source..source + 4]);
                }
            }
        }
        tray.set_icon(Some(tauri::image::Image::new_owned(pixels, 64, 64))).map_err(|_| "Could not update tray progress.")?;
        tray.set_tooltip(Some(format!("HomePlace Desktop · Sending files · {percent}%"))).map_err(|_| "Could not update tray tooltip.")?;
    } else {
        tray.set_icon(Some(base.clone())).map_err(|_| "Could not restore tray icon.")?;
        let _ = tray.set_tooltip(Some("HomePlace Desktop"));
    }
    Ok(())
}

pub fn show_quick_share_from_extension<R: Runtime>(app: &AppHandle<R>) {
    if let Some(rect) = quick_share_anchor(app) {
        show_quick_share(app, rect, true);
    } else {
        show_quick_share_near_cursor(app);
    }
}

/// Incoming consent is a quiet tray hint, never a focus-stealing popup.
pub fn show_quick_share_incoming<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("quick-share") else { return; };
    if window.is_visible().unwrap_or(false) { return; }
    if !QUICK_SHARE_PINNED.load(Ordering::Relaxed) {
        let _ = window.set_size(tauri::LogicalSize::new(104.0, 56.0));
    }
    if let Some(rect) = quick_share_anchor(app) {
        show_quick_share(app, rect, false);
    }
}

#[tauri::command]
pub fn open_quick_share(app: AppHandle, text: Option<String>) -> Result<(), String> {
    if let Some(value) = text {
        let value = value.trim();
        if value.is_empty()
            || value.chars().count() > 8_000
            || value
                .chars()
                .any(|character| character.is_control() && character != '\n' && character != '\t')
        {
            return Err("The quick-share text is invalid.".into());
        }
        app.emit("quick-share-stage-text", value)
            .map_err(|_| "Could not prepare the quick-share window.".to_string())?;
    }
    show_quick_share_near_cursor(&app);
    Ok(())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExchangeStage {
    text: Option<String>,
    file_path: Option<String>,
}

#[tauri::command]
pub fn open_exchange_window(
    app: AppHandle,
    text: Option<String>,
    file_path: Option<String>,
) -> Result<(), String> {
    if text.is_some() == file_path.is_some() {
        return Err("Choose one text item or one file for a temporary exchange.".into());
    }
    if let Some(value) = text.as_deref()
        && (value.trim().is_empty()
            || value.len() > 16 * 1024
            || value.chars().any(|character| {
                character.is_control() && !matches!(character, '\n' | '\r' | '\t')
            }))
    {
        return Err("The exchange text must be at most 16 KiB.".into());
    }
    if let Some(value) = file_path.as_deref() {
        let path = std::path::Path::new(value);
        let metadata = std::fs::metadata(path)
            .map_err(|_| "The shared exchange file is unavailable.".to_string())?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 10 * 1024 * 1024 * 1024 {
            return Err("Choose a file between 1 byte and 10 GiB. The server limit is checked before upload.".into());
        }
    }
    show_main_window(&app);
    app.emit("exchange-stage", ExchangeStage { text, file_path })
        .map_err(|_| "Could not open temporary exchange in HomePlace.".to_string())?;
    Ok(())
}

pub fn refresh_menu<R: Runtime>(app: &AppHandle<R>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Ok(menu) = build_menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn show_quick_share<R: Runtime>(app: &AppHandle<R>, tray_rect: Rect, focus: bool) {
    QUICK_SHARE_PRESENTATION.fetch_add(1, Ordering::SeqCst);
    let Some(window) = app.get_webview_window("quick-share") else {
        return;
    };
    crate::quick_share::prepare_show(app);
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let tray_position = tray_rect.position.to_physical::<f64>(scale_factor);
    let tray_size = tray_rect.size.to_physical::<f64>(scale_factor);
    let window_size = window.outer_size().unwrap_or_default();
    let mut x = tray_position.x + (tray_size.width - f64::from(window_size.width)) / 2.0;
    let mut y = tray_position.y + tray_size.height + 6.0 * scale_factor;

    let anchor_x = tray_position.x + tray_size.width / 2.0;
    let anchor_y = tray_position.y + tray_size.height / 2.0;
    let anchor_monitor = window.available_monitors().ok().and_then(|monitors| {
        monitors.into_iter().find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            anchor_x >= f64::from(position.x)
                && anchor_x < f64::from(position.x + size.width as i32)
                && anchor_y >= f64::from(position.y)
                && anchor_y < f64::from(position.y + size.height as i32)
        })
    });
    if let Some(monitor) = anchor_monitor.or_else(|| window.current_monitor().ok().flatten()) {
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let min_x = f64::from(monitor_position.x) + 8.0 * scale_factor;
        let max_x =
            f64::from(monitor_position.x + monitor_size.width as i32 - window_size.width as i32)
                - 8.0 * scale_factor;
        x = x.clamp(min_x, max_x.max(min_x));
        let monitor_bottom = f64::from(monitor_position.y + monitor_size.height as i32);
        if y + f64::from(window_size.height) > monitor_bottom {
            y = tray_position.y - f64::from(window_size.height) - 6.0 * scale_factor;
        }
    }

    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    let _ = window.show();
    if focus {
        let _ = window.set_focus();
    }
    let _ = app.emit("quick-share-opened", focus);
}

#[tauri::command]
pub fn set_quick_share_pointer_inside(inside: bool) {
    QUICK_SHARE_POINTER_INSIDE.store(inside, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_quick_share_pinned(pinned: bool) {
    QUICK_SHARE_PINNED.store(pinned, Ordering::Relaxed);
}

pub fn set_connection_state<R: Runtime>(app: &AppHandle<R>, state: ConnectionState) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let tooltip = match state {
        ConnectionState::Connected => "HomePlace Desktop — Connected",
        ConnectionState::Interrupted => "HomePlace Desktop — Reconnecting",
        ConnectionState::NotConfigured => "HomePlace Desktop — Not configured",
    };
    let _ = tray.set_tooltip(Some(tooltip));
}

pub fn notify_window_hidden<R: Runtime>(app: &AppHandle<R>) {
    if BACKGROUND_NOTICE_SHOWN.swap(true, Ordering::Relaxed) {
        return;
    }
    let _ = app
        .notification()
        .builder()
        .title("HomePlace Desktop is still running")
        .body("Link remains active in the system tray. Use Quit HomePlace to stop it.")
        .show();
}

fn tray_command(id: &str) -> Option<TrayCommand> {
    match id {
        "quick-share" => Some(TrayCommand::QuickShare),
        "open" => Some(TrayCommand::Show),
        "navigate:devices" => Some(TrayCommand::Navigate("devices")),
        "navigate:clipboard" => Some(TrayCommand::Navigate("clipboard")),
        "navigate:transfers" => Some(TrayCommand::Navigate("transfers")),
        "navigate:productivity" => Some(TrayCommand::Navigate("productivity")),
        "reconnect" => Some(TrayCommand::Reconnect),
        "quit" => Some(TrayCommand::Quit),
        _ => None,
    }
}

fn profile_server_id(id: &str) -> Option<&str> {
    let server_id = id.strip_prefix("profile:")?;
    uuid::Uuid::parse_str(server_id).ok()?;
    Some(server_id)
}

fn menu_label(value: &str) -> String {
    let mut label: String = value.chars().take(48).collect();
    if value.chars().count() > 48 {
        label.push('…');
    }
    label.replace('&', "&&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_only_known_tray_commands() {
        assert_eq!(tray_command("quick-share"), Some(TrayCommand::QuickShare));
        assert_eq!(tray_command("open"), Some(TrayCommand::Show));
        assert_eq!(
            tray_command("navigate:transfers"),
            Some(TrayCommand::Navigate("transfers"))
        );
        assert_eq!(tray_command("reconnect"), Some(TrayCommand::Reconnect));
        assert_eq!(tray_command("quit"), Some(TrayCommand::Quit));
        assert_eq!(tray_command("notification.deliver"), None);
    }

    #[test]
    fn accepts_only_uuid_profile_menu_ids() {
        assert_eq!(
            profile_server_id("profile:e54f9bfa-2543-4be2-bc07-c1eb3d0947ee"),
            Some("e54f9bfa-2543-4be2-bc07-c1eb3d0947ee")
        );
        assert_eq!(profile_server_id("profile:none"), None);
        assert_eq!(profile_server_id("profile:../../credential"), None);
    }

    #[test]
    fn bounds_and_escapes_profile_labels() {
        assert_eq!(menu_label("Home & Lab"), "Home && Lab");
        assert!(menu_label(&"a".repeat(80)).chars().count() <= 49);
    }
}
