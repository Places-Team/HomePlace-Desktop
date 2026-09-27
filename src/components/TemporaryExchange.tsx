import { useEffect, useState } from "react";
import type { Language } from "../lib/i18n";
import { fileLimitLabel, useFileTransferLimit } from "../lib/useFileTransferLimit";

export type ExchangeContent =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string; name: string };

export type ExchangeExpiryOption = { minutes: number; label: string };
export type ExchangeAccess = "account" | "link";

export type ExchangeReceipt = {
  id: string;
  code: string;
  url: string;
  kind: ExchangeContent["kind"];
  expiresAt: string;
  deleteAfterRead: boolean;
  access: ExchangeAccess;
};

export type ExchangeRetrieval =
  | { kind: "text"; text: string }
  | { kind: "file"; savedPath: string; name: string };

/** An app-level port. The server API mapping belongs outside this component. */
export type TemporaryExchangeGateway = {
  list: () => Promise<ExchangeReceipt[]>;
  create: (content: ExchangeContent, expiresInMinutes: number, deleteAfterRead: boolean, access: ExchangeAccess, onProgress: (transferred: number, total: number) => void) => Promise<ExchangeReceipt>;
  retrieve: (code: string, onProgress: (transferred: number, total: number) => void) => Promise<ExchangeRetrieval | null>;
  remove: (id: string) => Promise<void>;
};

type Props = {
  language: Language;
  gateway: TemporaryExchangeGateway;
  expiryOptions: ExchangeExpiryOption[];
  initialContent?: ExchangeContent | null;
  onChooseFile: () => Promise<{ path: string; name: string } | null>;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validCode(code: string): boolean {
  return code.trim().length > 0 && code.length <= 256;
}

export function TemporaryExchange({ language, gateway, expiryOptions, initialContent, onChooseFile }: Props) {
  const fileLimit = useFileTransferLimit();
  const ru = language === "ru";
  const [content, setContent] = useState<ExchangeContent | null>(initialContent ?? null);
  const [text, setText] = useState(initialContent?.kind === "text" ? initialContent.text : "");
  const [expiryMinutes, setExpiryMinutes] = useState(() => expiryOptions[0]?.minutes ?? 0);
  const [deleteAfterRead, setDeleteAfterRead] = useState(false);
  const [access, setAccess] = useState<ExchangeAccess>("link");
  const [receipts, setReceipts] = useState<ExchangeReceipt[]>([]);
  const [code, setCode] = useState("");
  const [retrieved, setRetrieved] = useState<ExchangeRetrieval | null>(null);
  const [busy, setBusy] = useState<"create" | "retrieve" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ transferred: number; total: number } | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{ transferred: number; total: number } | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void gateway.list().then((items) => {
        if (active) setReceipts(items);
      }).catch((reason) => {
        if (active) setError(errorText(reason));
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [gateway]);

  const readyContent = content?.kind === "file" ? content : text.trim() ? { kind: "text" as const, text: text.trim() } : null;
  const selectedExpiryMinutes = expiryOptions.some((option) => option.minutes === expiryMinutes) ? expiryMinutes : (expiryOptions[0]?.minutes ?? 0);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  async function create() {
    if (!readyContent || busy || !expiryOptions.some((option) => option.minutes === selectedExpiryMinutes)) return;
    setBusy("create");
    setError(null);
    setProgress(null);
    try {
      const created = await gateway.create(readyContent, selectedExpiryMinutes, deleteAfterRead, access, (transferred, total) => {
        setProgress({ transferred, total });
      });
      if (!created.code || !created.url || !Number.isFinite(Date.parse(created.expiresAt))) {
        throw new Error(ru ? "Сервер вернул неполную ссылку обмена." : "The server returned an incomplete exchange link.");
      }
      setReceipts((previous) => [created, ...previous.filter((item) => item.id !== created.id)]);
      setNow(Date.now());
      setDeleteConfirmId(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function retrieve() {
    const entered = code.trim();
    if (!validCode(entered) || busy) return;
    setBusy("retrieve");
    setError(null);
    setRetrieved(null);
    setDownloadProgress(null);
    try {
      const result = await gateway.retrieve(entered, (transferred, total) => {
        setDownloadProgress({ transferred, total });
      });
      if (result) {
        setRetrieved(result);
        setReceipts((previous) => previous.filter((item) => !(item.code === entered && item.deleteAfterRead)));
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
      setDownloadProgress(null);
    }
  }

  async function remove(id: string) {
    if (busy || deleteConfirmId !== id) return;
    setBusy("delete");
    setError(null);
    try {
      await gateway.remove(id);
      setReceipts((previous) => previous.filter((item) => item.id !== id));
      setDeleteConfirmId(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="glass-card temporary-exchange" aria-label={ru ? "Временный обмен" : "Temporary exchange"} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault();
      const dropped = event.dataTransfer.getData("text/plain");
      if (dropped) { setText(dropped); setContent(null); setError(null); }
    }}>
      <div className="section-heading">
        <div><p className="eyebrow">HomePlace Link</p><h3>{ru ? "Временный обмен" : "Temporary exchange"}</h3></div>
      </div>
      <p className="temporary-exchange-intro">{ru ? "Передайте код или ссылку вместо выбора устройства. Доступ истечёт сам — или удалите его раньше." : "Share a code or link without choosing a device. Access expires automatically, or you can remove it sooner."}</p>
      <p className="temporary-exchange-note">{ru ? "Ссылка использует текущий адрес сервера. Локальный IP работает только там, где этот адрес доступен." : "The link uses your current server address. A local IP works only where that address is reachable."}</p>

      <div className="temporary-exchange-columns">
        <div className="temporary-exchange-column">
          <h4>{ru ? "Создать" : "Create"}</h4>
          {content?.kind === "file" ? (
            <div className="temporary-exchange-file">
              <span title={content.name}>{content.name}</span>
              <button type="button" onClick={() => setContent(null)} disabled={busy !== null} aria-label={ru ? "Убрать файл" : "Remove file"}>×</button>
            </div>
          ) : (
            <textarea value={text} onChange={(event) => { setText(event.target.value); setContent(null); }} placeholder={ru ? "Текст или ссылка" : "Text or link"} rows={4} disabled={busy !== null} />
          )}
          <button type="button" className="temporary-exchange-secondary" disabled={busy !== null} onClick={() => {
            void onChooseFile().then((file) => {
              if (file) { setContent({ kind: "file", ...file }); setText(""); setError(null); }
            }).catch((reason) => setError(errorText(reason)));
          }}>{ru ? "Выбрать файл" : "Choose file"}</button>
          <p className="temporary-exchange-note">{ru ? `Один файл до ${fileLimitLabel(fileLimit, language)} или текст.` : `One file up to ${fileLimitLabel(fileLimit, language)}, or text.`}</p>
          <label className="temporary-exchange-field">
            <span>{ru ? "Срок действия" : "Expires after"}</span>
            <select value={selectedExpiryMinutes} disabled={busy !== null || expiryOptions.length === 0} onChange={(event) => setExpiryMinutes(Number(event.target.value))}>
              {expiryOptions.map((option) => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}
            </select>
          </label>
          <label className="temporary-exchange-field">
            <span>{ru ? "Кто может открыть" : "Who can open it"}</span>
            <select value={access} disabled={busy !== null} onChange={(event) => setAccess(event.target.value as ExchangeAccess)}>
              <option value="account">{ru ? "Пользователи HomePlace" : "HomePlace users"}</option>
              <option value="link">{ru ? "Любой с кодом" : "Anyone with the code"}</option>
            </select>
          </label>
          <label className="temporary-exchange-check"><input type="checkbox" checked={deleteAfterRead} disabled={busy !== null} onChange={(event) => setDeleteAfterRead(event.target.checked)} />{ru ? "Одноразовый обмен" : "One-time exchange"}</label>
          {access === "link" && <p className="temporary-exchange-note">{ru ? "Любой с этой ссылкой сможет открыть содержимое до истечения срока." : "Anyone with this link can open its contents until it expires."}</p>}
          {access === "account" && <p className="temporary-exchange-note">{ru ? "Любой авторизованный пользователь этого сервера с кодом сможет открыть содержимое." : "Any signed-in user of this server with the code can open its contents."}</p>}
          {deleteAfterRead && <p className="temporary-exchange-note">{ru ? "Одноразовый файл расходуется в момент начала скачивания; прерванную загрузку нельзя возобновить." : "A one-time file is consumed when its download starts; an interrupted download cannot be resumed."}</p>}
          <button type="button" className="temporary-exchange-primary" disabled={!readyContent || expiryOptions.length === 0 || busy !== null} onClick={() => void create()}>{busy === "create" ? (ru ? "Создаём…" : "Creating…") : (ru ? "Создать ссылку" : "Create link")}</button>
          {progress && progress.total > 0 && <div className="temporary-exchange-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={Math.min(progress.transferred, progress.total)}><span style={{ width: `${Math.min(100, progress.transferred / progress.total * 100)}%` }} /></div>}
          {receipts.length > 0 && <div className="temporary-exchange-receipts">
            <h5>{ru ? "Активные ссылки" : "Active links"}</h5>
            {receipts.map((receipt) => {
              const expiresAt = Date.parse(receipt.expiresAt);
              const expired = Number.isFinite(expiresAt) && expiresAt <= now;
              const minutesLeft = Number.isFinite(expiresAt) ? Math.max(0, Math.ceil((expiresAt - now) / 60_000)) : 0;
              return <div className="temporary-exchange-receipt" key={receipt.id}>
                <b>{ru ? "Код" : "Code"}: {receipt.code}</b>
                <span>{expired ? (ru ? "Срок истёк" : "Expired") : `${ru ? "Осталось" : "Time left"}: ${minutesLeft} ${ru ? "мин" : "min"} · ${ru ? "до" : "until"} ${new Date(receipt.expiresAt).toLocaleString(ru ? "ru-RU" : "en-US")}`}</span>
                <span>{receipt.access === "account" ? (ru ? "Пользователи HomePlace" : "HomePlace users") : (ru ? "Любой с кодом" : "Anyone with the code")}{receipt.deleteAfterRead ? ` · ${ru ? "одноразовый" : "one-time"}` : ""}</span>
                <div>
                  <button type="button" disabled={expired} onClick={() => void copy(receipt.url)}>{ru ? "Копировать ссылку" : "Copy link"}</button>
                  <button type="button" disabled={expired} onClick={() => void copy(receipt.code)}>{ru ? "Копировать код" : "Copy code"}</button>
                  <button type="button" disabled={busy !== null} onClick={() => setDeleteConfirmId(receipt.id)}>{ru ? "Удалить" : "Delete"}</button>
                </div>
                {deleteConfirmId === receipt.id && <div className="temporary-exchange-confirm"><span>{ru ? "Ссылка перестанет работать сразу." : "The link will stop working immediately."}</span><button type="button" disabled={busy !== null} onClick={() => void remove(receipt.id)}>{ru ? "Да, удалить" : "Delete now"}</button><button type="button" onClick={() => setDeleteConfirmId(null)}>{ru ? "Отмена" : "Cancel"}</button></div>}
              </div>;
            })}
          </div>}
        </div>

        <div className="temporary-exchange-column">
          <h4>{ru ? "Получить" : "Retrieve"}</h4>
          <label className="temporary-exchange-field"><span>{ru ? "Код обмена" : "Exchange code"}</span><input value={code} onChange={(event) => { setCode(event.target.value); setRetrieved(null); }} autoComplete="off" spellCheck={false} placeholder={ru ? "Введите код" : "Enter a code"} /></label>
          <button type="button" className="temporary-exchange-primary" disabled={!validCode(code.trim()) || busy !== null} onClick={() => void retrieve()}>{busy === "retrieve" ? (ru ? "Открываем…" : "Opening…") : (ru ? "Получить содержимое" : "Retrieve content")}</button>
          {downloadProgress && downloadProgress.total > 0 && <div className="temporary-exchange-progress" role="progressbar" aria-valuemin={0} aria-valuemax={downloadProgress.total} aria-valuenow={Math.min(downloadProgress.transferred, downloadProgress.total)}><span style={{ width: `${Math.min(100, downloadProgress.transferred / downloadProgress.total * 100)}%` }} /></div>}
          <p className="temporary-exchange-note">{ru ? "Одноразовый обмен может исчезнуть сразу после получения. Содержимое не загружается при вводе кода." : "A one-time exchange may disappear immediately after retrieval. Typing a code does not fetch its contents."}</p>
          {retrieved?.kind === "text" && <div className="temporary-exchange-retrieved"><p>{retrieved.text}</p><button type="button" onClick={() => void copy(retrieved.text)}>{ru ? "Копировать текст" : "Copy text"}</button></div>}
          {retrieved?.kind === "file" && <p className="temporary-exchange-retrieved">{ru ? "Файл сохранён" : "File saved"}: <b>{retrieved.name}</b></p>}
        </div>
      </div>
      {error && <p className="setting-error" role="alert">{error}</p>}
    </section>
  );
}
