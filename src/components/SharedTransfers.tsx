import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { useSharedTransfers } from "../lib/sharedTransfers";
import { sendProgressPercent } from "../lib/shareSendProgress";
import type { Language } from "../lib/i18n";

export function SharedTransfers({ language, history = false }: { language: Language; history?: boolean }) {
  const snapshot = useSharedTransfers();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const items = history ? snapshot.transfers.slice(0, 8) : snapshot.transfers.filter(item => item.status === "sending");
  if (!items.length) return null;
  const ru = language === "ru";
  return <section className="shared-transfers" aria-label={ru ? "Исходящие передачи" : "Outgoing transfers"}>
    {items.map(item => <article className="shared-transfer" key={item.id}>
      <div><strong>{item.names.length === 1 ? item.names[0] : `${item.names[0]} +${item.names.length - 1}`}</strong><small>→ {item.targetName}</small></div>
      <span role="status">{item.status === "sending" ? `${sendProgressPercent(item.progress)}%` : item.status === "sent" ? (ru ? "Отправлено" : "Sent") : item.status === "cancelled" ? (ru ? "Отменено" : "Cancelled") : (ru ? "Ошибка" : "Failed")}</span>
      {item.status === "sending" && <>
        <progress max={100} value={sendProgressPercent(item.progress)} aria-label={ru ? "Прогресс отправки" : "Send progress"} />
        <button type="button" disabled={cancelling === item.id} onClick={() => {
          setCancelling(item.id); setCancelError(null);
          void invoke("cancel_share_send", { operationId: item.id }).catch(reason => setCancelError(String(reason))).finally(() => setCancelling(null));
        }}>{ru ? "Отменить" : "Cancel"}</button>
      </>}
      {item.status === "failed" && item.error && <p role="alert">{item.error}</p>}
    </article>)}
    {cancelError && <p role="alert">{cancelError}</p>}
  </section>;
}
