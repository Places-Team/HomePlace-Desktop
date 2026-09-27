import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ExchangeExpiryOption, ExchangeReceipt, ExchangeRetrieval, TemporaryExchangeGateway } from "../components/TemporaryExchange";
import type { Language } from "./i18n";

type NativeExchange = {
  token: string;
  url: string;
  kind: "text" | "file";
  access: "account" | "link";
  filename?: string | null;
  size?: number | null;
  deleteAfterOpen: boolean;
  createdAt: string;
  expiresAt: string;
};

type NativeRetrieval = {
  kind: "text" | "file";
  text?: string | null;
  savedPath?: string | null;
  name?: string | null;
};

type TransferProgress = {
  transferId: string;
  transferredBytes: number;
  totalBytes: number;
};

export function exchangeExpiryOptions(language: Language): ExchangeExpiryOption[] {
  return language === "ru"
    ? [{ minutes: 10, label: "10 минут" }, { minutes: 60, label: "1 час" }, { minutes: 1440, label: "1 день" }]
    : [{ minutes: 10, label: "10 minutes" }, { minutes: 60, label: "1 hour" }, { minutes: 1440, label: "1 day" }];
}

function receipt(item: NativeExchange): ExchangeReceipt {
  return {
    id: item.token,
    code: item.token,
    url: item.url,
    kind: item.kind,
    access: item.access,
    expiresAt: item.expiresAt,
    deleteAfterRead: item.deleteAfterOpen,
  };
}

export const exchangeGateway: TemporaryExchangeGateway = {
  async list() {
    return (await invoke<NativeExchange[]>("list_exchanges")).map(receipt);
  },

  async create(content, expiresInMinutes, deleteAfterRead, access, onProgress) {
    const options = { expiresInSeconds: expiresInMinutes * 60, deleteAfterOpen: deleteAfterRead, access };
    if (content.kind === "text") {
      return receipt(await invoke<NativeExchange>("create_text_exchange", { ...options, text: content.text }));
    }
    const transferId = crypto.randomUUID().replace(/-/g, "");
    const stop = await listen<TransferProgress>("link-file-transfer-progress", ({ payload }) => {
      if (payload.transferId === transferId) onProgress(payload.transferredBytes, payload.totalBytes);
    });
    try {
      return receipt(await invoke<NativeExchange>("create_file_exchange", {
        ...options,
        filePath: content.path,
        transferId,
      }));
    } finally {
      stop();
    }
  },

  async retrieve(code, onProgress): Promise<ExchangeRetrieval | null> {
    const transferId = crypto.randomUUID().replace(/-/g, "");
    const stop = await listen<TransferProgress>("link-file-transfer-progress", ({ payload }) => {
      if (payload.transferId === transferId) onProgress(payload.transferredBytes, payload.totalBytes);
    });
    let item: NativeRetrieval | null;
    try {
      item = await invoke<NativeRetrieval | null>("retrieve_exchange", { token: code, transferId });
    } finally {
      stop();
    }
    if (!item) return null;
    if (item.kind === "text" && typeof item.text === "string") return { kind: "text", text: item.text };
    if (item.kind === "file" && typeof item.savedPath === "string" && typeof item.name === "string") {
      return { kind: "file", savedPath: item.savedPath, name: item.name };
    }
    throw new Error("The HomePlace server returned an invalid exchange result.");
  },

  async remove(id) {
    await invoke("delete_exchange", { token: id });
  },
};
