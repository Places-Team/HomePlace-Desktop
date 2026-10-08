import { invoke } from "@tauri-apps/api/core";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import type { Language } from "../lib/i18n";
import { filterContainers, filterEvents, filterMediaResults, filterServices } from "../lib/workspaceFilters";
import "../styles/server-workspace.css";

type QueueItem = { title: string; status: string; progress: number };
type ArrInstance = {
  label: string;
  kind: string;
  queueCount: number;
  warnings: number;
  queue: QueueItem[];
  upcoming: Array<{ title: string; sub?: string; at: number }>;
};
type Service = { id: string; title: string; status: string; latencyMs?: number | null; checkedAt?: string | null };
type Container = { id: string; name: string; image?: string; state?: string; status?: string; hostLabel?: string; health?: string };
type Event = { id: string; title: string; detail?: string; severity: string; at: string; count?: number };
type Overview = {
  serverTime: string;
  telegram?: { connected: boolean; enabled: boolean; source: string };
  requests: {
    instances: ArrInstance[];
    qbittorrent?: { active: number; total: number; downloadSpeed: number; uploadSpeed: number } | null;
  };
  monitoring: {
    total: number;
    online: number;
    offline: number;
    unknown: number;
    services: Service[];
    containers: { total: number; running: number; stopped: number; problems: number; items: Container[] };
    recent: Event[];
  };
};
type SearchResult = {
  instanceLabel: string;
  kind: string;
  title: string;
  year?: number;
  overview?: string;
  externalId: number;
  inLibrary: boolean;
};
type WorkspaceProps = { kind: "media" | "monitoring"; language: Language; activeServerId: string | null; onOpenConnections: () => void };

function message(error: unknown): string {
  return typeof error === "string" && error.trim() ? error : "HomePlace could not complete the request.";
}

function stamp(value: string | null | undefined, language: Language): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(language === "ru" ? "ru-RU" : "en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function speed(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B/s";
  const unit = bytes >= 1024 ** 2 ? "MB/s" : "KB/s";
  return `${(bytes / (unit === "MB/s" ? 1024 ** 2 : 1024)).toFixed(1)} ${unit}`;
}

export function ServerWorkspace({ kind, language, activeServerId, onOpenConnections }: WorkspaceProps) {
  const ru = language === "ru";
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pane, setPane] = useState<"services" | "containers" | "events">("containers");
  const [monitorQuery, setMonitorQuery] = useState("");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [mediaFilter, setMediaFilter] = useState<"all" | "movies" | "series">("all");
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchVersion = useRef(0);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SearchResult | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [requestNotice, setRequestNotice] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const overviewVersion = useRef(0);

  const refresh = useCallback(async () => {
    if (!activeServerId) return;
    const version = ++overviewVersion.current;
    try {
      const data = await invoke<Overview>("link_mobile_overview");
      if (version !== overviewVersion.current) return;
      setOverview(data);
      setError(null);
    } catch (reason) {
      if (version === overviewVersion.current) setError(message(reason));
    } finally {
      if (version === overviewVersion.current) setLoading(false);
    }
  }, [activeServerId]);

  useEffect(() => {
    const version = ++overviewVersion.current;
    if (!activeServerId) return;
    invoke<Overview>("link_mobile_overview")
      .then((data) => {
        if (version !== overviewVersion.current) return;
        setOverview(data);
        setError(null);
      })
      .catch((reason) => {
        if (version === overviewVersion.current) setError(message(reason));
      })
      .finally(() => {
        if (version === overviewVersion.current) setLoading(false);
      });
    const wake = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(wake, 60_000);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      overviewVersion.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [activeServerId, refresh]);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2 || searching) return;
    const version = ++searchVersion.current;
    setSearching(true);
    setSearchError(null);
    setRequestNotice(null);
    setRequestError(null);
    try {
      const response = await invoke<{ results: SearchResult[] }>("link_media_search", { query: query.trim() });
      if (version !== searchVersion.current) return;
      setResults(response.results.filter((item) => item.title && Number.isInteger(item.externalId) && item.externalId > 0));
      setSearched(true);
    } catch (reason) {
      if (version !== searchVersion.current) return;
      const detail = message(reason);
      setSearchError(detail.includes("not approved") ? (ru ? "Поиск требует разрешения media.request. Повторно привяжите компьютер и одобрите его в HomePlace." : "Search needs media.request. Pair this computer again and approve it in HomePlace.") : detail);
    } finally {
      if (version === searchVersion.current) setSearching(false);
    }
  }

  async function addRequest() {
    if (!confirm || requesting) return;
    setRequesting(true);
    setRequestNotice(null);
    setRequestError(null);
    try {
      await invoke("link_media_request", { instanceLabel: confirm.instanceLabel, externalId: confirm.externalId });
      setRequestNotice(ru ? `«${confirm.title}» добавлено в ${confirm.instanceLabel}. Состояние очереди появится после обновления.` : `“${confirm.title}” was added to ${confirm.instanceLabel}. Refresh to see its queue status.`);
      setResults((items) => items.map((item) => item.externalId === confirm.externalId && item.instanceLabel === confirm.instanceLabel ? { ...item, inLibrary: true } : item));
      setConfirm(null);
      void refresh();
    } catch (reason) {
      setRequestError(message(reason));
    } finally {
      setRequesting(false);
    }
  }

  if (!activeServerId) return <div className="workspace-state"><Icon name="link" size={24} /><h2>{ru ? "Подключите HomePlace" : "Connect HomePlace"}</h2><button type="button" className="workspace-refresh" onClick={onOpenConnections}>{ru ? "Открыть подключения" : "Open connections"}</button></div>;

  const monitoring = overview?.monitoring;
  const requests = overview?.requests;
  const instances = requests?.instances ?? [];
  const filteredInstances = filterMediaResults(instances, mediaFilter);
  const queue = filteredInstances.flatMap((instance) => (instance.queue ?? []).map((item) => ({ ...item, instance: instance.label })));
  const upcoming = filteredInstances
    .flatMap((instance) => (instance.upcoming ?? []).map((item) => ({ ...item, instance: instance.label })))
    .filter((item) => Number.isFinite(item.at) && !Number.isNaN(new Date(item.at).getTime()) && item.title)
    .sort((a, b) => a.at - b.at)
    .slice(0, 12);
  const tabs = [
    { id: "containers" as const, label: ru ? "Контейнеры" : "Containers", count: monitoring?.containers?.total ?? 0 },
    { id: "services" as const, label: ru ? "Сервисы" : "Services", count: monitoring?.total ?? 0 },
    { id: "events" as const, label: ru ? "События" : "Events", count: monitoring?.recent?.length ?? 0 },
  ];
  const containers = filterContainers(monitoring?.containers?.items ?? [], monitorQuery, problemsOnly);
  const services = filterServices(monitoring?.services ?? [], monitorQuery, problemsOnly);
  const events = filterEvents(monitoring?.recent ?? [], monitorQuery);
  const filteredResults = filterMediaResults(results, mediaFilter);

  return <section className="server-workspace">
    <div className="workspace-toolbar">
      <div><strong>{kind === "media" ? (ru ? "Медиазапросы" : "Media requests") : (ru ? "Состояние сервера" : "Server status")}</strong><small>{overview ? `${ru ? "Обновлено" : "Updated"} ${stamp(overview.serverTime, language)}` : (ru ? "Данные HomePlace" : "HomePlace data")}</small></div>
      <div className="workspace-toolbar-actions"><button type="button" onClick={() => void invoke("open_server_page", { page: kind }).catch((reason) => setError(message(reason)))} className="workspace-refresh"><Icon name="open" size={16} />{ru ? "Открыть на сервере" : "Open on server"}</button><button type="button" onClick={() => { setLoading(true); void refresh(); }} disabled={loading} className="workspace-refresh"><Icon name="refresh" size={16} />{loading ? (ru ? "Обновление…" : "Refreshing…") : (ru ? "Обновить" : "Refresh")}</button></div>
    </div>
    {error && <div className="workspace-warning" role="status"><Icon name="bell" size={18} /><span>{error.includes("not approved") ? (ru ? "Для этой вкладки нужны разрешения HomePlace. Повторно привяжите компьютер и одобрите доступ к мониторингу и медиазапросам." : "This view needs HomePlace permissions. Pair this computer again and approve monitoring and media requests.") : error}</span><button type="button" onClick={error.includes("not approved") ? onOpenConnections : () => void refresh()}>{error.includes("not approved") ? (ru ? "Подключения" : "Connections") : (ru ? "Повторить" : "Retry")}</button></div>}
    {!overview && loading && <div className="workspace-state"><Icon name="refresh" size={24} /><h2>{ru ? "Загружаем данные…" : "Loading server data…"}</h2></div>}
    {overview && kind === "monitoring" && monitoring && <>
      <div className="workspace-summary">
        <div><small>{ru ? "Контейнеры" : "Containers"}</small><strong>{monitoring.containers?.running ?? 0}<span> / {monitoring.containers?.total ?? 0}</span></strong><em>{ru ? "работают" : "running"}</em></div>
        <div><small>{ru ? "Сервисы" : "Services"}</small><strong>{monitoring.online}<span> / {monitoring.total}</span></strong><em>{ru ? "доступны" : "online"}</em></div>
        <div><small>{ru ? "Проблемы" : "Problems"}</small><strong>{(monitoring.containers?.problems ?? 0) + monitoring.offline}</strong><em>{ru ? "контейнеры и проверки" : "containers and checks"}</em></div>
      </div>
      {overview.telegram && <div className="workspace-source-note"><span className={`workspace-dot ${overview.telegram.connected && overview.telegram.enabled ? "good" : "unknown"}`} /><b>Telegram</b><span>{overview.telegram.connected ? (overview.telegram.enabled ? (ru ? "Настроен на сервере" : "Configured on server") : (ru ? "Отключён на сервере" : "Disabled on server")) : (ru ? "Не настроен" : "Not configured")}</span><small>{ru ? "Это состояние настройки, а не проверка доставки бота." : "Configuration status, not a bot delivery check."}</small></div>}
      <div className="workspace-tabs" role="tablist" aria-label={ru ? "Раздел мониторинга" : "Monitoring view"}>{tabs.map((tab, index) => <button role="tab" type="button" key={tab.id} id={`monitor-tab-${tab.id}`} aria-controls={`monitor-panel-${tab.id}`} aria-selected={pane === tab.id} tabIndex={pane === tab.id ? 0 : -1} className={pane === tab.id ? "selected" : ""} onClick={() => setPane(tab.id)} onKeyDown={(event) => {
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        setPane(tabs[next].id);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
      }}>{tab.label}<span>{tab.count}</span></button>)}</div>
      <div className="workspace-filterbar"><input type="search" aria-label={ru ? "Найти в мониторинге" : "Search monitoring"} placeholder={pane === "containers" ? (ru ? "Найти контейнер" : "Find a container") : pane === "services" ? (ru ? "Найти сервис" : "Find a service") : (ru ? "Найти событие" : "Find an event")} value={monitorQuery} onChange={(event) => setMonitorQuery(event.target.value)} />{pane !== "events" && <button type="button" className={problemsOnly ? "selected" : ""} aria-pressed={problemsOnly} onClick={() => setProblemsOnly((value) => !value)}>{ru ? "Только проблемы" : "Problems only"}</button>}{(monitorQuery || problemsOnly) && <button type="button" className="workspace-filter-clear" onClick={() => { setMonitorQuery(""); setProblemsOnly(false); }}>{ru ? "Сбросить" : "Clear"}</button>}</div>
      {pane === "containers" && <div className="workspace-list" role="tabpanel" id="monitor-panel-containers" aria-labelledby="monitor-tab-containers">{containers.length ? containers.map((item) => <div className="workspace-row" key={item.id}><span className={`workspace-dot ${item.state === "running" && item.health !== "unhealthy" ? "good" : "bad"}`} /><div><b>{item.name}</b><small>{[item.hostLabel, item.image].filter(Boolean).join(" · ")}</small></div><em>{item.health || item.status || item.state || "—"}</em></div>) : <p className="workspace-empty">{monitorQuery || problemsOnly ? (ru ? "Контейнеров по фильтру нет." : "No containers match this filter.") : (ru ? "Контейнеров пока нет или сервер Docker недоступен." : "No containers yet, or Docker is unavailable to HomePlace.")}</p>}</div>}
      {pane === "services" && <div className="workspace-list" role="tabpanel" id="monitor-panel-services" aria-labelledby="monitor-tab-services">{services.length ? services.map((item) => <div className="workspace-row" key={item.id}><span className={`workspace-dot ${item.status === "online" ? "good" : item.status === "offline" ? "bad" : "unknown"}`} /><div><b>{item.title}</b><small>{ru ? "Проверка" : "Checked"}: {stamp(item.checkedAt, language)}</small></div><em>{item.status === "online" ? (ru ? "Доступен" : "Online") : item.status === "offline" ? (ru ? "Недоступен" : "Offline") : (ru ? "Нет данных" : "Unknown")}{item.latencyMs != null ? ` · ${item.latencyMs} ms` : ""}</em></div>) : <p className="workspace-empty">{monitorQuery || problemsOnly ? (ru ? "Сервисов по фильтру нет." : "No services match this filter.") : (ru ? "На сервере ещё нет настроенных проверок." : "No monitored services are configured on the server.")}</p>}</div>}
      {pane === "events" && <div className="workspace-list" role="tabpanel" id="monitor-panel-events" aria-labelledby="monitor-tab-events">{events.length ? events.map((item) => <div className="workspace-row" key={item.id}><span className={`workspace-dot ${item.severity === "error" || item.severity === "critical" ? "bad" : "unknown"}`} /><div><b>{item.title}{(item.count ?? 1) > 1 ? ` ×${item.count}` : ""}</b><small>{item.detail || "—"}</small></div><em>{stamp(item.at, language)}</em></div>) : <p className="workspace-empty">{monitorQuery ? (ru ? "Событий по запросу нет." : "No events match this search.") : (ru ? "Недавних событий нет." : "No recent events.")}</p>}</div>}
    </>}
    {kind === "media" && <>
      {overview && <div className="workspace-summary media-summary">
        <div><small>Radarr / Sonarr</small><strong>{filteredInstances.length}</strong><em>{ru ? "экземпляров в разделе" : "instances in view"}</em></div>
        <div><small>{ru ? "Очередь" : "Queue"}</small><strong>{filteredInstances.reduce((count, item) => count + (item.queueCount || 0), 0)}</strong><em>{ru ? "задач в разделе" : "items in view"}</em></div>
        <div><small>qBittorrent</small><strong>{requests?.qbittorrent?.active ?? "—"}</strong><em>{requests?.qbittorrent ? `${speed(requests.qbittorrent.downloadSpeed)} ↓` : (ru ? "Не подключён" : "Not connected")}</em></div>
      </div>}
      <div className="workspace-media-view" role="group" aria-label={ru ? "Тип медиаконтента" : "Media type"}>
        {([ ["all", ru ? "Всё" : "All"], ["movies", ru ? "Фильмы" : "Movies"], ["series", ru ? "Сериалы" : "Series"] ] as const).map(([value, label]) =>
          <button type="button" key={value} aria-pressed={mediaFilter === value} className={mediaFilter === value ? "selected" : ""} onClick={() => setMediaFilter(value)}>{label}</button>
        )}
        <span>{ru ? "Фильтр действует на поиск, очередь и календарь" : "Filters search, queue, and calendar"}</span>
      </div>
      <div className="workspace-media-grid">
        <section className="workspace-panel"><div className="workspace-panel-heading"><h2>{ru ? "Поиск" : "Search"}</h2><small>{ru ? "Фильмы и сериалы" : "Movies and shows"}</small></div><form className="workspace-search" onSubmit={(event) => void search(event)}><input aria-label={ru ? "Название фильма или сериала" : "Movie or show title"} value={query} onChange={(event) => { searchVersion.current += 1; setQuery(event.target.value); setSearching(false); setSearched(false); setResults([]); setSearchError(null); }} placeholder={ru ? "Название фильма или сериала" : "Movie or show title"} maxLength={80} /><button type="submit" disabled={searching || query.trim().length < 2}>{searching ? "…" : (ru ? "Найти" : "Search")}</button></form>
          {searchError && <p className="workspace-inline-error" role="alert">{searchError}</p>}{requestError && !confirm && <p className="workspace-inline-error" role="alert">{requestError}</p>}{requestNotice && <p className="workspace-notice" role="status">{requestNotice}</p>}
          {searched && !results.length && !searchError && <p className="workspace-empty">{ru ? "Ничего не найдено. Проверьте запрос и настройки Radarr/Sonarr." : "No results. Check the title and Radarr/Sonarr configuration."}</p>}
        {searched && results.length > 0 && <p className="workspace-result-count">{filteredResults.length} {ru ? "результатов" : "results"}</p>}
          {searched && results.length > 0 && filteredResults.length === 0 && <p className="workspace-empty">{ru ? "Для выбранного типа результатов нет." : "No results of this type."}</p>}
          <div className="workspace-results">{filteredResults.map((item) => <div className="workspace-result" key={`${item.instanceLabel}:${item.externalId}`}><span className="workspace-result-mark">{item.kind.toLowerCase().includes("sonarr") ? "S" : "R"}</span><div><b>{item.title}</b><small>{[item.year, item.instanceLabel].filter(Boolean).join(" · ")}</small>{item.overview && <p>{item.overview}</p>}</div><button type="button" disabled={item.inLibrary || requesting} onClick={() => setConfirm(item)}>{item.inLibrary ? (ru ? "В библиотеке" : "In library") : (ru ? "Добавить" : "Add")}</button></div>)}</div>
        </section>
        <section className="workspace-panel"><div className="workspace-panel-heading"><h2>{ru ? "Запросы и загрузки" : "Requests and downloads"}</h2><small>{ru ? "Очередь Radarr / Sonarr" : "Radarr / Sonarr queue"}</small></div>{!overview ? <p className="workspace-empty">{ru ? "Состояние очереди пока недоступно." : "Queue status is unavailable."}</p> : queue.length ? <div className="workspace-list">{queue.map((item, index) => <div className="workspace-queue-row" key={`${item.instance}:${item.title}:${index}`}><div><b>{item.title}</b><small>{item.instance} · {item.status}</small></div><span>{Math.round(Math.max(0, Math.min(100, item.progress || 0)))}%</span><div className="workspace-progress"><i style={{ width: `${Math.max(0, Math.min(100, item.progress || 0))}%` }} /></div></div>)}</div> : <p className="workspace-empty">{ru ? "Активных задач нет. Добавленные напрямую в Radarr/Sonarr задачи появятся здесь." : "No active tasks. Items added directly in Radarr/Sonarr appear here too."}</p>}
          {upcoming.length > 0 && <><div className="workspace-panel-heading workspace-subheading"><h3>{ru ? "Скоро" : "Upcoming"}</h3><small>{ru ? "Календарь Radarr / Sonarr" : "Radarr / Sonarr calendar"}</small></div><div className="workspace-list">{upcoming.map((item) => <div className="workspace-row" key={`${item.instance}:${item.title}:${item.at}`}><div><b>{item.title}</b><small>{[item.instance, item.sub].filter(Boolean).join(" · ")}</small></div><em>{stamp(new Date(item.at).toISOString(), language)}</em></div>)}</div></>}
          {instances.length > 0 && <div className="workspace-instances">{instances.map((item) => <div key={item.label}><b>{item.label}</b><span>{item.warnings > 0 ? `${item.warnings} ${ru ? "предупреждений" : "warnings"}` : item.upcoming?.length ? `${item.upcoming.length} ${ru ? "предстоящих" : "upcoming"}` : (ru ? "Нет предупреждений" : "No warnings")}</span></div>)}</div>}
        </section>
      </div>
      {confirm && <div className="workspace-confirm" role="dialog" aria-modal="true" aria-label={ru ? "Подтвердить медиазапрос" : "Confirm media request"}><div><h2>{ru ? "Добавить в медиатеку?" : "Add to library?"}</h2><p><b>{confirm.title}</b> → {confirm.instanceLabel}</p><small>{ru ? "Сервер использует профиль качества и папку по умолчанию в Radarr/Sonarr. Загрузка начнётся по их правилам." : "The server uses the default quality profile and root folder in Radarr/Sonarr. Downloading follows their rules."}</small>{requestError && <p className="workspace-inline-error" role="alert">{requestError}</p>}<div className="workspace-confirm-actions"><button type="button" onClick={() => { setConfirm(null); setRequestError(null); }} disabled={requesting}>{ru ? "Отмена" : "Cancel"}</button><button type="button" onClick={() => void addRequest()} disabled={requesting}>{requesting ? (ru ? "Добавляем…" : "Adding…") : (ru ? "Добавить" : "Add")}</button></div></div></div>}
    </>}
  </section>;
}
