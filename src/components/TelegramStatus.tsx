import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Language } from "../lib/i18n";

type Status = { connected: boolean; enabled: boolean; source: string; canTest: boolean };

function detail(reason: unknown, ru: boolean): string {
  const value = typeof reason === "string" ? reason : "";
  if (value.includes("does not support") || value.includes("HTTP 405")) {
    return ru ? "Обновите сервер HomePlace, чтобы проверять Telegram здесь." : "Update the HomePlace server to check Telegram here.";
  }
  return value || (ru ? "Не удалось связаться с HomePlace." : "Could not reach HomePlace.");
}

export function TelegramStatus({ activeServerId, language }: { activeServerId: string | null; language: Language }) {
  const ru = language === "ru";
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(Boolean(activeServerId));
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const result = await invoke<Status>("link_telegram_status");
      if (version === requestVersion.current) setStatus(result);
    } catch (reason) {
      if (version === requestVersion.current) {
        setStatus(null);
        setError(detail(reason, ru));
      }
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [ru]);

  useEffect(() => {
    if (!activeServerId) return;
    const version = ++requestVersion.current;
    invoke<Status>("link_telegram_status")
      .then((result) => {
        if (version === requestVersion.current) setStatus(result);
      })
      .catch((reason) => {
        if (version !== requestVersion.current) return;
        setStatus(null);
        setError(detail(reason, ru));
      })
      .finally(() => {
        if (version === requestVersion.current) setLoading(false);
      });
    return () => { requestVersion.current += 1; };
  }, [activeServerId, ru]);

  function refresh() {
    if (!activeServerId || loading) return;
    setLoading(true);
    setError(null);
    void load();
  }

  async function sendTest() {
    if (!status?.enabled || !status.canTest || testing) return;
    setTesting(true);
    setNotice(null);
    setError(null);
    try {
      await invoke("link_telegram_test");
      setNotice(ru ? "Тестовое сообщение отправлено в Telegram." : "Test message sent to Telegram.");
    } catch (reason) {
      setError(detail(reason, ru));
    } finally {
      setTesting(false);
    }
  }

  const state = !activeServerId
    ? (ru ? "Подключите HomePlace" : "Connect HomePlace")
    : !status
      ? (loading ? (ru ? "Проверяем…" : "Checking…") : "—")
      : !status.connected
        ? (ru ? "Не настроен" : "Not configured")
        : status.enabled
          ? (ru ? "Включён" : "Enabled")
          : (ru ? "Выключен" : "Disabled");

  return <article className="glass-card settings-panel">
    <div className="section-heading"><div><p className="eyebrow">HomePlace Link</p><h3>Telegram</h3></div><button type="button" className="workspace-refresh" onClick={() => void refresh()} disabled={!activeServerId || loading}>{ru ? "Обновить" : "Refresh"}</button></div>
    <div className="settings-row"><span><b>{ru ? "Доставка уведомлений" : "Notification delivery"}</b><small>{ru ? "Состояние настройки на сервере; тест проверяет доставку сообщения." : "Server configuration status; the test checks message delivery."}</small></span><em>{state}</em></div>
    {status?.enabled && !status.canTest && <p className="hint">{ru ? "Для теста нужно разрешение telegram.send. Повторно привяжите компьютер и подтвердите доступ в HomePlace." : "Testing needs telegram.send. Pair this computer again and approve access in HomePlace."}</p>}
    {status?.enabled && status.canTest && <button type="button" className="workspace-refresh" disabled={testing} onClick={() => void sendTest()}>{testing ? (ru ? "Отправляем…" : "Sending…") : (ru ? "Отправить тест" : "Send test")}</button>}
    {error && <p className="setting-error" role="alert">{error}</p>}
    {notice && <p className="hint" role="status">{notice}</p>}
  </article>;
}
