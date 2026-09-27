import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Language } from "../lib/i18n";

type Notification = {
  id: string;
  title: string;
  body: string;
  tag?: string | null;
  urgent: boolean;
  createdAt: string;
  deliveredAt?: string | null;
};

type HistoryPage = {
  notifications: Notification[];
  nextCursor?: string | null;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function NotificationHistory({ language, activeServerId }: { language: Language; activeServerId?: string | null }) {
  const [items, setItems] = useState<Notification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const request = useRef(false);

  const load = useCallback((cursor?: string) => {
    if (!activeServerId || request.current) return;
    request.current = true;
    setBusy(true);
    setError(null);
    void invoke<HistoryPage>("list_notification_history", { cursor: cursor ?? null })
      .then((page) => {
        setItems((previous) => {
          if (!cursor) return page.notifications;
          const known = new Set(previous.map((item) => item.id));
          return [...previous, ...page.notifications.filter((item) => !known.has(item.id))];
        });
        setNextCursor(page.nextCursor ?? null);
      })
      .catch((cause) => setError(message(cause)))
      .finally(() => {
        request.current = false;
        setBusy(false);
        setLoaded(true);
      });
  }, [activeServerId]);

  useEffect(() => {
    if (!activeServerId) return;
    const refresh = () => {
      if (document.visibilityState === "visible") load();
    };
    load();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, [activeServerId, load]);

  const ru = language === "ru";
  return (
    <article className="glass-card notification-history">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{ru ? "Доставлено на это устройство" : "Delivered to this device"}</p>
          <h3>{ru ? "Журнал уведомлений" : "Notification history"}</h3>
        </div>
        <button type="button" disabled={busy || !activeServerId} onClick={() => load()}>
          {ru ? "Обновить" : "Refresh"}
        </button>
      </div>
      {!activeServerId && <p className="notification-history-note">{ru ? "Подключите сервер, чтобы увидеть историю." : "Connect a server to view history."}</p>}
      {error && <p className="setting-error" role="alert">{error}</p>}
      {busy && !loaded && <p className="notification-history-note">{ru ? "Загружаем…" : "Loading…"}</p>}
      {loaded && items.length === 0 && !error && <p className="notification-history-note">{ru ? "Доставленных уведомлений пока нет." : "No delivered notifications yet."}</p>}
      {items.length > 0 && (
        <div className="notification-history-list">
          {items.map((item) => (
            <div className={`notification-history-row${item.urgent ? " urgent" : ""}`} key={item.id}>
              <span className="notification-history-indicator" aria-hidden="true" />
              <div>
                <div className="notification-history-row-title">
                  <b>{item.title}</b>
                  <time dateTime={item.deliveredAt ?? item.createdAt}>
                    {new Intl.DateTimeFormat(ru ? "ru-RU" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.deliveredAt ?? item.createdAt))}
                  </time>
                </div>
                <p>{item.body}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      {nextCursor && <button className="notification-history-more" type="button" disabled={busy} onClick={() => load(nextCursor)}>{ru ? "Показать ещё" : "Show more"}</button>}
    </article>
  );
}
