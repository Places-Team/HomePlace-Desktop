import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { Language } from "./i18n";

export function useFileTransferLimit() {
  const [limit, setLimit] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void invoke<number>("get_file_transfer_limit")
        .then((bytes) => {
          if (active) setLimit(Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null);
        })
        .catch(() => { if (active) setLimit(null); });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, []);

  return limit;
}

export function fileLimitLabel(limit: number | null, language: Language) {
  if (limit === null) return language === "ru" ? "лимит сервера уточняется" : "checking server limit";
  const gib = limit / (1024 ** 3);
  const mib = limit / (1024 ** 2);
  return gib >= 1
    ? `${Number(gib.toFixed(1))} ${language === "ru" ? "ГиБ" : "GiB"}`
    : `${Math.floor(mib)} ${language === "ru" ? "МиБ" : "MiB"}`;
}
