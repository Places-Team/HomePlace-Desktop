import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Language } from "../lib/i18n";
import { parsePlantReminderSettings, plantSettingsConflict, type PlantReminderSettings as Settings } from "../lib/plantSync";

export function PlantReminderSettings({ language }: { language: Language }) {
  const ru = language === "ru";
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [telegramConsent, setTelegramConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const dirty = useRef(false);
  const latest = useRef<Settings | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void invoke<{ settings: unknown }>("link_plant_settings")
        .then((reply) => {
          if (cancelled) return;
          const parsed = parsePlantReminderSettings(reply.settings);
          if (!parsed) throw new Error("The server returned invalid plant reminder settings.");
          if (latest.current && plantSettingsConflict(latest.current, parsed, dirty.current)) setRemoteChanged(true);
          if (!dirty.current) setDraft(parsed);
          latest.current = parsed;
          setSaved(parsed);
          if (!dirty.current) setMessage(null);
        })
        .catch((reason) => { if (!cancelled) setMessage(String(reason)); });
    };
    const start = window.setTimeout(load, 0);
    const onFocus = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; window.clearTimeout(start); window.removeEventListener("focus", onFocus); };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !parsePlantReminderSettings(draft) || remoteChanged) return;
    if (draft.telegram && !saved?.telegram && !telegramConsent) return;
    setBusy(true);
    try {
      const reply = await invoke<{ settings: unknown }>("link_plant_settings", { body: draft });
      const parsed = parsePlantReminderSettings(reply.settings);
      if (!parsed) throw new Error("The server returned invalid plant reminder settings.");
      setSaved(parsed);
      setDraft(parsed);
      latest.current = parsed;
      dirty.current = false;
      setRemoteChanged(false);
      setTelegramConsent(false);
      setMessage(ru ? "Настройки напоминаний сохранены для этого аккаунта." : "Reminder settings saved for this account.");
    } catch (reason) { setMessage(String(reason)); }
    finally { setBusy(false); }
  }

  return <details className="plant-settings">
    <summary>{ru ? "Напоминания о поливе" : "Watering reminders"}</summary>
    {!draft ? <p role="status">{message || (ru ? "Загружаем настройки…" : "Loading settings…")}</p> : <form onSubmit={(event) => void save(event)}>
      <p>{ru ? "Общие настройки для ваших устройств HomePlace. Напоминания отдельных растений можно отключить рядом с ними." : "Shared by your HomePlace devices. You can disable reminders for individual plants above."}</p>
      <label><input type="checkbox" checked={draft.enabled} onChange={(event) => { dirty.current = true; setDraft({ ...draft, enabled: event.target.checked }); }} />{ru ? "Напоминать о поливе" : "Enable watering reminders"}</label>
      <label><input type="checkbox" checked={draft.app} onChange={(event) => { dirty.current = true; setDraft({ ...draft, app: event.target.checked }); }} />{ru ? "Уведомления в приложениях" : "App notifications"}</label>
      <label><input type="checkbox" checked={draft.telegram} onChange={(event) => { dirty.current = true; setDraft({ ...draft, telegram: event.target.checked }); setTelegramConsent(false); }} />Telegram</label>
      {draft.telegram && !saved?.telegram && <div className="plant-settings-warning"><p>{ru ? "Telegram может отправлять названия растений в настроенный на сервере чат, в том числе общий. Включайте только если доверяете участникам этого чата." : "Telegram may send plant names to the server's configured chat, which may be shared. Enable this only if you trust everyone in that chat."}</p><label><input type="checkbox" checked={telegramConsent} onChange={(event) => setTelegramConsent(event.target.checked)} />{ru ? "Понимаю, куда могут прийти уведомления" : "I understand where notifications may be sent"}</label></div>}
      <div className="plant-settings-fields"><label>{ru ? "Время" : "Time"}<input type="time" value={draft.time} onChange={(event) => { dirty.current = true; setDraft({ ...draft, time: event.target.value }); }} /></label><label>{ru ? "Часовой пояс" : "Time zone"}<input type="text" list="plant-time-zones" value={draft.timeZone} onChange={(event) => { dirty.current = true; setDraft({ ...draft, timeZone: event.target.value }); }} maxLength={80} /><datalist id="plant-time-zones">{[Intl.DateTimeFormat().resolvedOptions().timeZone, "Europe/Moscow", "Europe/Berlin", "Asia/Yekaterinburg", "UTC"].filter((value, index, values) => values.indexOf(value) === index).map((value) => <option key={value} value={value} />)}</datalist></label><label>{ru ? "Повтор через дни" : "Repeat every days"}<input type="number" min={0} max={30} value={draft.repeatDays} onChange={(event) => { dirty.current = true; setDraft({ ...draft, repeatDays: Number(event.target.value) }); }} /></label></div>
      <small>{ru ? "0 — одно уведомление до следующего полива; 1–30 — повторять, пока не отметите полив." : "0 sends once per watering cycle; 1–30 repeats until you mark the plant watered."}</small>
      {remoteChanged && <p role="alert">{ru ? "Настройки изменились на другом устройстве. Ваши правки не затронуты. Обновите данные перед сохранением." : "Settings changed on another device. Your edits are untouched. Reload before saving."}</p>}
      <div className="plant-settings-actions"><button type="submit" disabled={busy || remoteChanged || !parsePlantReminderSettings(draft) || (draft.telegram && !saved?.telegram && !telegramConsent)}>{busy ? (ru ? "Сохраняем…" : "Saving…") : (ru ? "Сохранить" : "Save")}</button><button type="button" disabled={busy} onClick={() => { dirty.current = false; setDraft(saved); setRemoteChanged(false); setTelegramConsent(false); setMessage(null); }}>{remoteChanged ? (ru ? "Загрузить настройки сервера" : "Load server settings") : (ru ? "Отменить" : "Cancel")}</button></div>
      {message && <p role="status">{message}</p>}
    </form>}
  </details>;
}
