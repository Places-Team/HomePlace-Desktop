import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "./Icon";
import type { Language } from "../lib/i18n";
import "../styles/media-catalog.css";

type Kind = "movie" | "tv";
type MediaItem = {
  id: number; kind: Kind; title: string; originalTitle?: string; overview: string;
  poster?: string; backdrop?: string; year?: number; rating?: number;
  status: string; isAnime?: boolean;
};
type Catalog = { configured: boolean; unavailable?: boolean; page: number; pages: number; items: MediaItem[] };
type Season = { number: number; name: string; episodeCount: number; airDate?: string };
type Details = MediaItem & { genres: string[]; runtimeMinutes?: number; tagline?: string; releaseStatus?: string; studios: string[]; seasons: Season[] };
type Profile = { key: string; label: string; is4k: boolean };
type DetailReply = { details: Details; profiles: Profile[] };
type MediaRequest = { id: number; title: string; kind: Kind; status: string; requestedBy: string; createdAt: string; poster?: string };
type QueueItem = { title: string; status: string; progress: number };
type Overview = { requests: { instances: Array<{ label: string; kind: string; queue: QueueItem[] }> } };

const imageCache = new Map<string, string>();
function errorText(reason: unknown): string {
  return typeof reason === "string" && reason.trim() ? reason : "HomePlace could not load media.";
}
function statusLabel(value: string, ru: boolean): string {
  const labels: Record<string, [string, string]> = {
    available: ["Доступно", "Available"], "partially-available": ["Частично доступно", "Partially available"],
    requested: ["Запрошено", "Requested"], pending: ["Ожидает", "Pending"], missing: ["Не добавлено", "Not added"],
    approved: ["Одобрено", "Approved"], declined: ["Отклонено", "Declined"],
    failed: ["Ошибка", "Failed"], completed: ["Завершено", "Completed"],
  };
  return labels[value]?.[ru ? 0 : 1] ?? value.replaceAll("_", " ");
}

function Artwork({ path, title, wide = false }: { path?: string; title: string; wide?: boolean }) {
  const [image, setImage] = useState<{ path: string; data: string } | null>(null);
  const source = path ? (image?.path === path ? image.data : imageCache.get(path) ?? null) : null;
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!path || source) return;
    const target = frame.current;
    if (!target) return;
    let cancelled = false;
    const fetchImage = () => {
      void invoke<string>("link_media_image", { path }).then((data) => {
        if (cancelled) return;
        if (imageCache.size >= 100) imageCache.delete(imageCache.keys().next().value!);
        imageCache.set(path, data);
        setImage({ path, data });
      }).catch(() => undefined);
    };
    if (!window.IntersectionObserver) { fetchImage(); return () => { cancelled = true; }; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); fetchImage(); }
    }, { rootMargin: "240px" });
    observer.observe(target);
    return () => { cancelled = true; observer.disconnect(); };
  }, [path, source]);
  return <div ref={frame} className={`media-art ${wide ? "wide" : ""}`}>{source ? <img src={source} alt="" loading="lazy" /> : <span aria-hidden>{title.slice(0, 1).toUpperCase()}</span>}</div>;
}

export function MediaCatalog({ activeServerId, language, onOpenConnections }: {
  activeServerId: string | null; language: Language; onOpenConnections: () => void;
}) {
  const ru = language === "ru";
  const [tab, setTab] = useState<"discover" | "requests" | "downloads">("discover");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [kind, setKind] = useState<"all" | Kind>("all");
  const [category, setCategory] = useState<"all" | "anime">("all");
  const [page, setPage] = useState(1);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const catalogVersion = useRef(0);
  const [requests, setRequests] = useState<MediaRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [detail, setDetail] = useState<DetailReply | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailVersion = useRef(0);
  const [profileKey, setProfileKey] = useState("");
  const [allSeasons, setAllSeasons] = useState(true);
  const [seasons, setSeasons] = useState<number[]>([]);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    if (!activeServerId) return;
    const version = ++catalogVersion.current;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const data = await invoke<Catalog>("link_media_catalog", { query: submitted, kind, category, page, language });
      if (version === catalogVersion.current) setCatalog(data);
    } catch (reason) {
      if (version === catalogVersion.current) setCatalogError(errorText(reason));
    } finally { if (version === catalogVersion.current) setCatalogLoading(false); }
  }, [activeServerId, submitted, kind, category, page, language]);

  const loadRequests = useCallback(async () => {
    if (!activeServerId) return;
    setRequestsLoading(true);
    try {
      const data = await invoke<{ requests: MediaRequest[] }>("link_media_catalog_requests");
      setRequests(data.requests);
      setRequestsError(null);
    } catch (reason) { setRequestsError(errorText(reason)); }
    finally { setRequestsLoading(false); }
  }, [activeServerId]);

  const loadOverview = useCallback(async () => {
    if (!activeServerId) return;
    try { setOverview(await invoke<Overview>("link_mobile_overview")); setOverviewError(null); }
    catch (reason) { setOverviewError(errorText(reason)); }
  }, [activeServerId]);

  useEffect(() => {
    const start = window.setTimeout(() => void loadCatalog(), 0);
    return () => { catalogVersion.current += 1; window.clearTimeout(start); };
  }, [loadCatalog]);

  useEffect(() => {
    const start = window.setTimeout(() => { void loadRequests(); void loadOverview(); }, 0);
    const wake = () => { if (document.visibilityState === "visible") { void loadRequests(); void loadOverview(); } };
    window.addEventListener("focus", wake);
    return () => { detailVersion.current += 1; window.clearTimeout(start); window.removeEventListener("focus", wake); };
  }, [loadRequests, loadOverview]);

  function search(event: FormEvent) {
    event.preventDefault();
    const value = query.trim();
    if (value && value.length < 2) return;
    setPage(1);
    setSubmitted(value);
  }

  async function open(item: MediaItem) {
    const version = ++detailVersion.current;
    setSelected(item); setDetail(null); setDetailError(null); setDetailLoading(true);
    setProfileKey(""); setAllSeasons(true); setSeasons([]);
    try {
      const data = await invoke<DetailReply>("link_media_details", { kind: item.kind, id: item.id, language });
      if (version === detailVersion.current) setDetail(data);
    } catch (reason) { if (version === detailVersion.current) setDetailError(errorText(reason)); }
    finally { if (version === detailVersion.current) setDetailLoading(false); }
  }

  async function sendRequest() {
    if (!detail || sending || (!allSeasons && detail.details.kind === "tv" && seasons.length === 0)) return;
    setSending(true); setDetailError(null);
    try {
      await invoke("link_create_catalog_request", {
        kind: detail.details.kind, mediaId: detail.details.id,
        seasons: detail.details.kind === "tv" && !allSeasons ? seasons : null,
        profileKey: profileKey || null,
      });
      setNotice(ru ? `«${detail.details.title}» отправлено в Seerr. Статус появится в запросах.` : `“${detail.details.title}” was sent to Seerr. Follow it in Requests.`);
      setSelected(null); setDetail(null);
      void loadRequests(); void loadCatalog();
    } catch (reason) { setDetailError(errorText(reason)); }
    finally { setSending(false); }
  }

  if (!activeServerId) return <div className="workspace-state"><Icon name="link" size={24} /><h2>{ru ? "Подключите HomePlace" : "Connect HomePlace"}</h2><p>{ru ? "Привяжите компьютер, чтобы открыть медиатеку." : "Pair this computer to open the media catalog."}</p><button type="button" className="workspace-refresh" onClick={onOpenConnections}>{ru ? "Открыть подключения" : "Open connections"}</button></div>;

  const queue = overview?.requests.instances.flatMap((instance) => (instance.queue ?? []).map((item) => ({ ...item, instance: instance.label }))) ?? [];
  return <section className="media-catalog">
    <header className="media-catalog-top"><div><p className="eyebrow">HOMEPLACE · MEDIA</p><h2>{ru ? "Медиатека" : "Media catalog"}</h2><p>{ru ? "Находите, запрашивайте и отслеживайте фильмы и сериалы." : "Discover, request, and follow movies and series."}</p></div><button type="button" className="media-refresh" onClick={() => { void loadCatalog(); void loadRequests(); void loadOverview(); }}><Icon name="refresh" size={17} />{ru ? "Обновить" : "Refresh"}</button></header>
    <nav className="media-catalog-tabs" aria-label={ru ? "Разделы медиатеки" : "Media sections"}>{([ ["discover", ru ? "Каталог" : "Discover"], ["requests", ru ? "Запросы" : "Requests"], ["downloads", ru ? "Загрузки" : "Downloads"] ] as const).map(([value, label]) => <button type="button" key={value} className={tab === value ? "active" : ""} aria-current={tab === value ? "page" : undefined} onClick={() => setTab(value)}>{label}{value === "requests" && requests.length > 0 && <span>{requests.length}</span>}{value === "downloads" && queue.length > 0 && <span>{queue.length}</span>}</button>)}</nav>
    {notice && <div className="media-notice" role="status">{notice}<button type="button" onClick={() => { setNotice(null); setTab("requests"); }}>{ru ? "Открыть запросы" : "View requests"}</button></div>}
    {tab === "discover" && <>
      <form className="media-search" onSubmit={search}><Icon name="search" size={20} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={ru ? "Фильм, сериал или аниме" : "Movie, series, or anime"} aria-label={ru ? "Поиск медиатеки" : "Search media catalog"} maxLength={120} /><button type="submit" disabled={!!query.trim() && query.trim().length < 2}>{ru ? "Найти" : "Search"}</button>{submitted && <button type="button" className="media-clear" onClick={() => { setQuery(""); setSubmitted(""); setPage(1); }}>{ru ? "Сбросить" : "Clear"}</button>}</form>
      <div className="media-filters" aria-label={ru ? "Фильтры каталога" : "Catalog filters"}>{([ ["all", ru ? "Все" : "All"], ["movie", ru ? "Фильмы" : "Movies"], ["tv", ru ? "Сериалы" : "Series"] ] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={kind === value} onClick={() => { setKind(value); setPage(1); }}>{label}</button>)}<i aria-hidden /><button type="button" aria-pressed={category === "anime"} onClick={() => { setCategory(category === "anime" ? "all" : "anime"); setPage(1); }}>{ru ? "Аниме" : "Anime"}</button></div>
      {catalogError ? <div className="media-state" role="alert"><h3>{ru ? "Каталог недоступен" : "Catalog unavailable"}</h3><p>{catalogError}</p><button type="button" onClick={() => void loadCatalog()}>{ru ? "Повторить" : "Retry"}</button></div> : catalogLoading && !catalog ? <div className="media-state"><p>{ru ? "Загружаем каталог…" : "Loading catalog…"}</p></div> : catalog && !catalog.configured ? <div className="media-state"><h3>{ru ? "Seerr ещё не настроен" : "Seerr is not configured"}</h3><p>{ru ? "Подключите Seerr в настройках HomePlace, чтобы искать и запрашивать медиа." : "Connect Seerr in HomePlace settings to search and request media."}</p></div> : catalog?.unavailable ? <div className="media-state" role="status"><h3>{ru ? "Seerr не отвечает" : "Seerr is not responding"}</h3><p>{ru ? "Настройка сохранена, но сервис сейчас недоступен." : "The integration is configured, but the service is unavailable."}</p><button type="button" onClick={() => void loadCatalog()}>{ru ? "Повторить" : "Retry"}</button></div> : <>
        <div className="media-section-heading"><div><h3>{submitted ? (ru ? "Результаты поиска" : "Search results") : category === "anime" ? (ru ? "Аниме" : "Anime") : (ru ? "Популярное сейчас" : "Trending now")}</h3><p>{catalogLoading ? (ru ? "Обновляем…" : "Updating…") : `${catalog?.items.length ?? 0} ${ru ? "на странице" : "on this page"}`}</p></div></div>
        {catalog?.items.length ? <div className="media-card-grid">{catalog.items.map((item) => <button type="button" className="media-card" key={`${item.kind}:${item.id}`} onClick={() => void open(item)}><Artwork path={item.poster} title={item.title} /><span className="media-card-copy"><strong>{item.title}</strong>{item.originalTitle && item.originalTitle !== item.title && <small className="media-original">{item.originalTitle}</small>}<small>{[item.year, item.kind === "movie" ? (ru ? "Фильм" : "Movie") : (ru ? "Сериал" : "Series")].filter(Boolean).join(" · ")}</small><em data-status={item.status}>{statusLabel(item.status, ru)}</em></span></button>)}</div> : <div className="media-state"><h3>{ru ? "Ничего не найдено" : "No titles found"}</h3><p>{ru ? "Попробуйте другое название или сбросьте фильтры." : "Try another title or clear the filters."}</p></div>}
        {(catalog?.pages ?? 1) > 1 && <div className="media-pagination"><button type="button" disabled={page <= 1 || catalogLoading} onClick={() => setPage((value) => value - 1)}>{ru ? "Назад" : "Previous"}</button><span>{page} / {catalog?.pages}</span><button type="button" disabled={page >= (catalog?.pages ?? 1) || catalogLoading} onClick={() => setPage((value) => value + 1)}>{ru ? "Дальше" : "Next"}</button></div>}
      </>}
    </>}
    {tab === "requests" && <><div className="media-section-heading"><div><h3>{ru ? "Запросы Seerr" : "Seerr requests"}</h3><p>{ru ? "Все текущие запросы на сервере" : "Current requests on your server"}</p></div><button type="button" onClick={() => void loadRequests()}>{ru ? "Обновить" : "Refresh"}</button></div>{requestsError ? <div className="media-state" role="alert">{requestsError}</div> : requestsLoading && !requests.length ? <div className="media-state">{ru ? "Загружаем запросы…" : "Loading requests…"}</div> : requests.length ? <div className="media-request-list">{requests.map((request) => <div className="media-request-row" key={request.id}><Artwork path={request.poster} title={request.title} /><div><strong>{request.title}</strong><small>{request.kind === "movie" ? (ru ? "Фильм" : "Movie") : (ru ? "Сериал" : "Series")} · {request.requestedBy || "Seerr"}</small></div><span>{statusLabel(request.status, ru)}</span></div>)}</div> : <div className="media-state">{ru ? "Запросов пока нет. Найдите первый фильм или сериал в каталоге." : "No requests yet. Discover a movie or series to get started."}</div>}</>}
    {tab === "downloads" && <><div className="media-section-heading"><div><h3>{ru ? "Очередь загрузок" : "Download queue"}</h3><p>Radarr · Sonarr</p></div><button type="button" onClick={() => void loadOverview()}>{ru ? "Обновить" : "Refresh"}</button></div>{overviewError && <p className="media-inline-error" role="alert">{overviewError}</p>}{queue.length ? <div className="media-download-list">{queue.map((item, index) => <div className="media-download-row" key={`${item.instance}:${item.title}:${index}`}><div><strong>{item.title}</strong><small>{item.instance} · {item.status}</small></div><span>{Math.round(Math.max(0, Math.min(100, item.progress || 0)))}%</span><div className="media-download-track"><i style={{ width: `${Math.max(0, Math.min(100, item.progress || 0))}%` }} /></div></div>)}</div> : <div className="media-state">{ru ? "Активных загрузок нет. Принятые запросы появятся здесь после отправки в Radarr или Sonarr." : "No active downloads. Approved requests appear here once sent to Radarr or Sonarr."}</div>}</>}
    {selected && <div className="media-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !sending) { setSelected(null); setDetail(null); } }}><section className="media-detail" role="dialog" aria-modal="true" aria-label={selected.title}><button type="button" className="media-detail-close" aria-label={ru ? "Закрыть карточку" : "Close details"} onClick={() => { if (!sending) { setSelected(null); setDetail(null); } }}>×</button>{detailLoading ? <div className="media-state">{ru ? "Загружаем подробности…" : "Loading details…"}</div> : detail ? <><div className="media-detail-hero"><Artwork path={detail.details.backdrop || detail.details.poster} title={detail.details.title} wide /><div><small>{detail.details.kind === "movie" ? (ru ? "ФИЛЬМ" : "MOVIE") : (ru ? "СЕРИАЛ" : "SERIES")} · {detail.details.year ?? "—"}</small><h2>{detail.details.title}</h2>{detail.details.originalTitle && detail.details.originalTitle !== detail.details.title && <p className="media-detail-original">{detail.details.originalTitle}</p>}<span className="media-detail-status">{statusLabel(detail.details.status, ru)}</span></div></div><div className="media-detail-body">{detail.details.tagline && <p className="media-tagline">{detail.details.tagline}</p>}<p>{detail.details.overview || (ru ? "Описание пока недоступно." : "No overview available.")}</p><div className="media-meta">{detail.details.genres?.length > 0 && <span>{detail.details.genres.join(" · ")}</span>}{detail.details.runtimeMinutes && <span>{detail.details.runtimeMinutes} {ru ? "мин" : "min"}</span>}{detail.details.releaseStatus && <span>{detail.details.releaseStatus}</span>}{detail.details.studios?.length > 0 && <span>{detail.details.studios.join(" · ")}</span>}</div>{detail.details.kind === "tv" && detail.details.seasons?.length > 0 && <div className="media-season-picker"><h3>{ru ? "Сезоны" : "Seasons"}</h3><label><input type="checkbox" checked={allSeasons} onChange={(event) => { setAllSeasons(event.target.checked); setSeasons([]); }} />{ru ? "Все сезоны" : "All seasons"}</label>{!allSeasons && <div className="media-season-grid">{detail.details.seasons.filter((season) => season.number > 0).map((season) => <label key={season.number}><input type="checkbox" checked={seasons.includes(season.number)} onChange={(event) => setSeasons((current) => event.target.checked ? [...current, season.number] : current.filter((value) => value !== season.number))} />{season.name || `${ru ? "Сезон" : "Season"} ${season.number}`}<small>{season.episodeCount} {ru ? "серий" : "episodes"}</small></label>)}</div>}</div>}<label className="media-profile">{ru ? "Качество" : "Quality"}<select value={profileKey} onChange={(event) => setProfileKey(event.target.value)}><option value="">{ru ? "По умолчанию на сервере" : "Server default"}</option>{detail.profiles.map((profile) => <option key={profile.key} value={profile.key}>{profile.label}{profile.is4k ? " · 4K" : ""}</option>)}</select></label>{detailError && <p className="media-inline-error" role="alert">{detailError}</p>}<div className="media-detail-actions"><button type="button" onClick={() => { setSelected(null); setDetail(null); }} disabled={sending}>{ru ? "Закрыть" : "Close"}</button><button type="button" className="primary" onClick={() => void sendRequest()} disabled={sending || (!allSeasons && detail.details.kind === "tv" && seasons.length === 0) || detail.details.status === "available"}>{sending ? (ru ? "Отправляем…" : "Sending…") : detail.details.status === "available" ? (ru ? "Уже доступно" : "Already available") : (ru ? "Запросить" : "Request")}</button></div></div></> : <div className="media-state" role="alert"><p>{detailError}</p><button type="button" onClick={() => void open(selected)}>{ru ? "Повторить" : "Retry"}</button></div>}</section></div>}
  </section>;
}
