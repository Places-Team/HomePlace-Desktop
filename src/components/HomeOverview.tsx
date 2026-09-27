import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "./Icon";
import type { Language } from "../lib/i18n";
import "../styles/home-overview.css";

type Overview = {
  serverTime: string;
  monitoring: {
    total: number;
    online: number;
    offline: number;
    containers: { total: number; running: number; problems: number };
    recent: Array<{ id: string; title: string; severity: string; at: string }>;
  };
  requests: {
    instances: Array<{
      label: string;
      kind: string;
      queueCount: number;
      queue: Array<{ title: string; progress: number; status: string }>;
      upcoming: Array<{ title: string; at: number }>;
    }>;
    qbittorrent?: { active: number; downloadSpeed: number } | null;
  };
};

type Plant = { id: string; name: string; intervalDays: number; lastWateredAt: string };

function plantsKey(serverId: string) { return `homeplace-desktop-plants-v1:${serverId}`; }

function readPlants(serverId: string): Plant[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(plantsKey(serverId)) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Plant =>
      typeof item === "object" && item !== null &&
      typeof item.id === "string" && typeof item.name === "string" &&
      Number.isInteger(item.intervalDays) && item.intervalDays >= 1 && item.intervalDays <= 90 &&
      typeof item.lastWateredAt === "string" && Number.isFinite(Date.parse(item.lastWateredAt))
    ).slice(0, 50);
  } catch { return []; }
}

function daysUntilWater(plant: Plant, today: Date): number {
  const last = new Date(plant.lastWateredAt);
  const due = Date.UTC(last.getFullYear(), last.getMonth(), last.getDate() + plant.intervalDays);
  return Math.round((due - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86_400_000);
}

function formatSpeed(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MiB/s";
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB/s`;
}

export function HomeOverview({ serverId, language, onNavigate }: {
  serverId: string;
  language: Language;
  onNavigate: (section: "media" | "monitoring" | "notifications") => void;
}) {
  const ru = language === "ru";
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [plants, setPlants] = useState<Plant[]>(() => readPlants(serverId));
  const [now, setNow] = useState(() => Date.now());
  const [plantName, setPlantName] = useState("");
  const [intervalDays, setIntervalDays] = useState(3);
  const [plantsError, setPlantsError] = useState<string | null>(null);
  const [lastDeletedPlant, setLastDeletedPlant] = useState<Plant | null>(null);
  const requestVersion = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const data = await invoke<Overview>("link_mobile_overview");
      if (version !== requestVersion.current) return;
      setOverview(data);
      setError(null);
    } catch (reason) {
      if (version !== requestVersion.current) return;
      setError(typeof reason === "string" ? reason : "HomePlace did not return the overview.");
    } finally { if (version === requestVersion.current) setLoading(false); }
  }, []);

  useEffect(() => {
    const start = window.setTimeout(() => void refresh(), 0);
    const onFocus = () => { if (document.visibilityState === "visible") { setNow(Date.now()); void refresh(); } };
    const timer = window.setInterval(onFocus, 60_000);
    window.addEventListener("focus", onFocus);
    return () => { requestVersion.current += 1; window.clearTimeout(start); window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  function savePlants(next: Plant[]): boolean {
    try {
      window.localStorage.setItem(plantsKey(serverId), JSON.stringify(next));
      setPlants(next);
      setPlantsError(null);
      return true;
    } catch {
      setPlantsError(ru ? "Не удалось сохранить растения на этом компьютере." : "Could not save plants on this computer.");
      return false;
    }
  }

  function addPlant(event: FormEvent) {
    event.preventDefault();
    const name = plantName.trim();
    if (!name || !Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 90) return;
    if (savePlants([...plants, { id: crypto.randomUUID(), name: name.slice(0, 80), intervalDays, lastWateredAt: new Date().toISOString() }])) setPlantName("");
  }

  function removePlant(plant: Plant) {
    if (savePlants(plants.filter((item) => item.id !== plant.id))) setLastDeletedPlant(plant);
  }

  const queue = overview?.requests.instances.flatMap((instance) =>
    (instance.queue ?? []).map((item) => ({ ...item, instance: instance.label }))
  ) ?? [];
  const upcoming = overview?.requests.instances.flatMap((instance) =>
    (instance.upcoming ?? []).map((item) => ({ ...item, instance: instance.label }))
  ).filter((item) => item.title && Number.isFinite(item.at) && item.at > now - 86_400_000)
    .sort((a, b) => a.at - b.at).slice(0, 2) ?? [];
  const problemCount = (overview?.monitoring.offline ?? 0) + (overview?.monitoring.containers.problems ?? 0);
  const today = new Date(now);
  const duePlants = plants.filter((plant) => daysUntilWater(plant, today) <= 0).length;

  return <div className="home-overview">
    <div className="home-overview-heading">
      <div><p className="eyebrow">{ru ? "СЕГОДНЯ" : "TODAY"}</p><h2>{ru ? "Что требует внимания" : "What needs attention"}</h2></div>
      <button type="button" onClick={() => void refresh()} disabled={loading} aria-label={ru ? "Обновить обзор" : "Refresh overview"}><Icon name="refresh" size={17} />{ru ? "Обновить" : "Refresh"}</button>
    </div>
    {error && <p className="home-overview-error" role="status">{error} <button type="button" onClick={() => void refresh()}>{ru ? "Повторить" : "Retry"}</button></p>}
    <div className="home-overview-grid">
      <section className="home-overview-service">
        <div className="home-overview-section-head"><span><Icon name="monitoring" size={20} /></span><div><h3>{ru ? "Сервер и сервисы" : "Server and services"}</h3><p>{ru ? "Состояние по последней проверке" : "Latest server check"}</p></div></div>
        {overview ? <>
          <div className="home-overview-numbers"><div><strong>{overview.monitoring.online}<small> / {overview.monitoring.total}</small></strong><span>{ru ? "сервисов доступны" : "services online"}</span></div><div><strong>{overview.monitoring.containers.running}<small> / {overview.monitoring.containers.total}</small></strong><span>{ru ? "контейнеров работают" : "containers running"}</span></div></div>
          <button type="button" className={problemCount > 0 ? "home-overview-alert" : "home-overview-clear"} onClick={() => onNavigate("monitoring")}><span>{problemCount > 0 ? (ru ? `${problemCount} требуют проверки` : `${problemCount} need attention`) : (ru ? "Проблем не обнаружено" : "No reported issues")}</span><Icon name="open" size={16} /></button>
          {overview.monitoring.recent?.[0] && <p className="home-overview-recent">{ru ? "Последнее событие" : "Latest event"}: {overview.monitoring.recent[0].title}</p>}
        </> : <p className="home-overview-empty">{loading ? (ru ? "Загружаем состояние…" : "Loading status…") : (ru ? "Данных пока нет." : "No data yet.")}</p>}
      </section>

      <section className="home-overview-media">
        <div className="home-overview-section-head"><span><Icon name="media" size={20} /></span><div><h3>{ru ? "Фильмы и сериалы" : "Movies and series"}</h3><p>{ru ? "Очередь Radarr и Sonarr" : "Radarr and Sonarr queue"}</p></div></div>
        {overview ? <>
          <div className="home-overview-media-line"><b>{queue.length}</b><span>{ru ? "в очереди" : "in queue"}</span><b>{overview.requests.qbittorrent?.active ?? "—"}</b><span>qBittorrent</span></div>
          {queue.slice(0, 2).map((item, index) => <div className="home-overview-queue" key={`${item.instance}:${item.title}:${index}`}><span>{item.title}</span><small>{item.instance} · {Math.round(Math.max(0, Math.min(100, item.progress || 0)))}%</small></div>)}
          {queue.length === 0 && <p className="home-overview-empty">{ru ? "Активных загрузок нет." : "No active downloads."}</p>}
          {upcoming.length > 0 && <div className="home-overview-upcoming"><small>{ru ? "СКОРО" : "UPCOMING"}</small>{upcoming.map((item) => <p key={`${item.instance}:${item.title}:${item.at}`}>{item.title}<span>{new Date(item.at).toLocaleDateString(ru ? "ru-RU" : "en-US", { day: "numeric", month: "short" })}</span></p>)}</div>}
          <p className="home-overview-speed">{ru ? "Скорость загрузки" : "Download speed"}: {formatSpeed(overview.requests.qbittorrent?.downloadSpeed ?? 0)}</p>
        </> : <p className="home-overview-empty">{loading ? (ru ? "Загружаем медиатеку…" : "Loading media…") : "—"}</p>}
        <button type="button" className="home-overview-link" onClick={() => onNavigate("media")}>{ru ? "Открыть медиа" : "Open media"}<Icon name="open" size={15} /></button>
      </section>

      <section className="home-overview-plants">
        <div className="home-overview-section-head"><span><Icon name="plant" size={20} /></span><div><h3>{ru ? "Растения" : "Plants"}</h3><p>{duePlants ? (ru ? `${duePlants} пора полить` : `${duePlants} need water`) : (ru ? "План полива" : "Watering plan")}</p></div></div>
        <p className="home-overview-local">{ru ? "Пока хранится только на этом компьютере; список телефона не синхронизирован." : "Stored on this computer for now; the phone list is not synced."}</p>
        {plants.length > 0 ? <div className="home-overview-plant-list">{[...plants].sort((a, b) => daysUntilWater(a, today) - daysUntilWater(b, today)).map((plant) => {
          const days = daysUntilWater(plant, today);
          return <div className="home-overview-plant" key={plant.id}><span><b>{plant.name}</b><small>{days < 0 ? (ru ? `Просрочено на ${-days} дн.` : `${-days} days overdue`) : days === 0 ? (ru ? "Полить сегодня" : "Water today") : (ru ? `Через ${days} дн.` : `In ${days} days`)}</small></span><button type="button" onClick={() => savePlants(plants.map((item) => item.id === plant.id ? { ...item, lastWateredAt: new Date().toISOString() } : item))}>{ru ? "Полито" : "Watered"}</button><button type="button" className="home-overview-remove" onClick={() => removePlant(plant)} aria-label={`${ru ? "Удалить" : "Remove"} ${plant.name}`}><Icon name="trash" size={15} /></button></div>;
        })}</div> : <p className="home-overview-empty">{ru ? "Добавьте растение и интервал полива." : "Add a plant and its watering interval."}</p>}
        {lastDeletedPlant && <p className="home-overview-undo" role="status">{ru ? `«${lastDeletedPlant.name}» удалено` : `${lastDeletedPlant.name} removed`} <button type="button" onClick={() => { if (savePlants([...plants, lastDeletedPlant])) setLastDeletedPlant(null); }}>{ru ? "Вернуть" : "Undo"}</button></p>}
        <form className="home-overview-plant-form" onSubmit={addPlant}><input aria-label={ru ? "Название растения" : "Plant name"} placeholder={ru ? "Название растения" : "Plant name"} value={plantName} onChange={(event) => setPlantName(event.target.value)} maxLength={80} required /><label>{ru ? "Каждые" : "Every"}<input type="number" min={1} max={90} value={intervalDays} onChange={(event) => setIntervalDays(Number(event.target.value))} />{ru ? "дн." : "days"}</label><button type="submit" disabled={!plantName.trim() || plants.length >= 50}><Icon name="plus" size={16} />{ru ? "Добавить" : "Add"}</button></form>
        {plantsError && <p className="home-overview-error" role="alert">{plantsError}</p>}
      </section>
    </div>
  </div>;
}
