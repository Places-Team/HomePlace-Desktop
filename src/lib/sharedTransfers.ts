import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export type ShareContent = { kind: "files"; paths: string[] } | { kind: "text" | "url"; value: string };
export type SendTarget = { id: string; name: string; supportsFileBatch?: boolean };
export type SharedProgress = { fileName: string; transferredBytes: number; totalBytes: number; fileIndex: number; fileCount: number };
export type SharedTransfer = {
  id: string; targetName: string; names: string[];
  status: "sending" | "sent" | "failed" | "cancelled";
  progress: SharedProgress | null; error: string | null;
};
export type TransferSnapshot = { revision: number; transfers: SharedTransfer[] };
const empty: TransferSnapshot = { revision: 0, transfers: [] };

export function useSharedTransfers() {
  const [snapshot, setSnapshot] = useState(empty);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const accept = (next: TransferSnapshot) => {
      if (!disposed && next && Array.isArray(next.transfers)) setSnapshot(current => next.revision >= current.revision ? next : current);
    };
    // Subscribe before reading so a completion during hydration is not lost.
    void listen<TransferSnapshot>("shared-transfers-changed", event => accept(event.payload)).then(unlisten => {
      if (disposed) { unlisten(); return; }
      stop = unlisten;
      void invoke<TransferSnapshot>("shared_transfers").then(accept).catch(() => {});
    }).catch(() => {});
    return () => { disposed = true; stop?.(); };
  }, []);
  return snapshot;
}

export async function sendShared(content: ShareContent, target: SendTarget) {
  const id = crypto.randomUUID();
  const names = content.kind === "files" ? content.paths.map(path => path.split(/[\\/]/).pop() || path) : [content.kind === "url" ? "URL" : "Text"];
  await invoke("start_shared_transfer", { id, targetName: target.name, names });
  const update = (status: SharedTransfer["status"], progress: SharedProgress | null = null, error: string | null = null) =>
    invoke("update_shared_transfer", { id, status, progress, error });
  let lastProgressAt = 0;
  const progress = (value: SharedProgress) => {
    const now = Date.now();
    if (value.transferredBytes < value.totalBytes && now - lastProgressAt < 150) return;
    lastProgressAt = now;
    void update("sending", value).catch(() => {});
  };
  try {
    if (content.kind !== "files") {
      await invoke("send_share_text", { targetDeviceId: target.id, kind: content.kind, value: content.value, operationId: id });
    } else if (content.paths.length > 1 && target.supportsFileBatch) {
      const stop = await listen<SharedProgress & { batchId: string }>("link-file-batch-send-progress", event => {
        progress({ ...event.payload, fileIndex: Math.max(0, event.payload.fileIndex - 1) });
      });
      try { await invoke("send_share_batch", { targetDeviceId: target.id, filePaths: content.paths, operationId: id }); }
      finally { stop(); }
    } else {
      for (const [fileIndex, filePath] of content.paths.entries()) {
        const transferId = crypto.randomUUID();
        const initial = { fileName: names[fileIndex], transferredBytes: 0, totalBytes: 0, fileIndex, fileCount: content.paths.length };
        await update("sending", initial);
        const stop = await listen<SharedProgress & { transferId: string }>("link-file-transfer-progress", event => {
          if (event.payload.transferId === transferId) progress({ ...event.payload, fileIndex, fileCount: content.paths.length });
        });
        try { await invoke("send_share_file", { targetDeviceId: target.id, filePath, transferId, operationId: id }); }
        finally { stop(); }
      }
    }
    await update("sent");
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    await update(message === "The transfer was cancelled." ? "cancelled" : "failed", null, message);
    throw reason;
  }
}
