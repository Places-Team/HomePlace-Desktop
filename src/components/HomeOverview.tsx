import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "./Icon";
import type { Language } from "../lib/i18n";
import { daysUntilWater, waterPlantRequest, type PlantFeatures, type SyncedPlant } from "../lib/plantSync";
import { PlantDetails } from "./PlantDetails";
import { PlantReminderSettings } from "./PlantReminderSettings";
import "../styles/home-overview.css";
import "../styles/plants.css";

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
type PlantReply = { plant?: SyncedPlant; conflict?: boolean; existing?: boolean };

function plantsKey(serverId: string) { return `homeplace-desktop-plants-v1:${serverId}`; }

function readPlants(serverId: string): Plant[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(plantsKey(serverId)) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Plant =>
      typeof item === "object" && item !== null &&
      typeof item.id === "string" && typeof item.name === "string" &&
      Number.isInteger(item.intervalDays) && item.intervalDays >= 1 && item.intervalDays <= 365 &&
      typeof item.lastWateredAt === "string" && Number.isFinite(Date.parse(item.lastWateredAt))
    ).slice(0, 50);
  } catch { return []; }
}

function formatSpeed(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MiB/s";
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB/s`;
}

export function HomeOverview({ serverId, language, onNavigate, requestedPlantId, onPlantRequestHandled }: {
  serverId: string;
  language: Language;
  onNavigate: (section: "media" | "monitoring" | "notifications" | "settings") => void;
  requestedPlantId?: string | null;
  onPlantRequestHandled?: () => void;
}) {
  const ru = language === "ru";
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localPlants, setLocalPlants] = useState<Plant[]>(() => readPlants(serverId));
  const [syncedPlants, setSyncedPlants] = useState<SyncedPlant[] | null>(null);
  const [plantFeatures, setPlantFeatures] = useState<PlantFeatures | null>(null);
  const [selectedPlantId, setSelectedPlantId] = useState<string | null>(null);
  const [plantsBusy, setPlantsBusy] = useState(false);
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

  const refreshPlants = useCallback(async () => {
    try {
      const data = await invoke<{ plants: SyncedPlant[] }>("link_plants");
      if (!Array.isArray(data.plants)) throw new Error("Invalid plant list");
      setSyncedPlants(data.plants);
      setPlantsError(null);
    } catch (reason) {
      setPlantsError(typeof reason === "string" ? reason : String(reason));
    }
  }, []);

  useEffect(() => {
    const start = window.setTimeout(() => void refreshPlants(), 0);
    const onFocus = () => { if (document.visibilityState === "visible") void refreshPlants(); };
    const timer = window.setInterval(onFocus, 60_000);
    window.addEventListener("focus", onFocus);
    return () => { window.clearTimeout(start); window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [refreshPlants]);

  useEffect(() => {
    const start = window.setTimeout(() => {
      void invoke<PlantFeatures>("link_plant_features")
        .then(setPlantFeatures)
        .catch(() => setPlantFeatures(null));
    }, 0);
    return () => window.clearTimeout(start);
  }, [serverId]);

  const plants = syncedPlants === null ? localPlants : syncedPlants.filter((item) => !item.deletedAt);
  const unimported = syncedPlants === null ? [] : localPlants.filter((item) => !syncedPlants.some((remote) => remote.clientId === item.id));
  const selectedPlant = syncedPlants?.find((item) => item.clientId === selectedPlantId && !item.deletedAt);

  useEffect(() => {
    if (!requestedPlantId || !syncedPlants?.some((item) => item.clientId === requestedPlantId && !item.deletedAt)) return;
    const start = window.setTimeout(() => {
      setSelectedPlantId(requestedPlantId);
      onPlantRequestHandled?.();
    }, 0);
    return () => window.clearTimeout(start);
  }, [requestedPlantId, syncedPlants, onPlantRequestHandled]);

  function savePlants(next: Plant[]): boolean {
    try {
      window.localStorage.setItem(plantsKey(serverId), JSON.stringify(next));
      setLocalPlants(next);
      setPlantsError(null);
      return true;
    } catch {
      setPlantsError(ru ? "Не удалось сохранить растения на этом компьютере." : "Could not save plants on this computer.");
      return false;
    }
  }

  async function changePlant(body: Record<string, unknown>) {
    setPlantsBusy(true);
    try {
      const reply = await invoke<PlantReply>("link_change_plant", { body });
      if (reply.conflict) {
        await refreshPlants();
        setPlantsError(ru ? "Растение изменилось на другом устройстве. Список обновлён." : "This plant changed on another device. The list has been refreshed.");
        return false;
      }
      await refreshPlants();
      return true;
    } catch (reason) {
      setPlantsError(typeof reason === "string" ? reason : String(reason));
      return false;
    } finally { setPlantsBusy(false); }
  }

  async function importLocalPlants() {
    setPlantsBusy(true);
    let failed = 0;
    try {
      for (const plant of unimported) {
        try {
          await invoke<PlantReply>("link_change_plant", { body: {
            action: "create", clientId: plant.id, name: plant.name, species: "", location: "", notes: "",
            intervalDays: plant.intervalDays, lastWateredAt: plant.lastWateredAt,
          } });
        } catch { failed += 1; }
      }
      await refreshPlants();
      if (failed) setPlantsError(ru ? `Не удалось перенести ${failed} растений; локальные копии сохранены.` : `Could not import ${failed} plants; local copies remain saved.`);
    } finally { setPlantsBusy(false); }
  }

  async function addPlant(event: FormEvent) {
    event.preventDefault();
    const name = plantName.trim();
    if (!name || !Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 365) return;
    if (syncedPlants === null) {
      if (savePlants([...localPlants, { id: crypto.randomUUID(), name: name.slice(0, 80), intervalDays, lastWateredAt: new Date().toISOString() }])) setPlantName("");
      return;
    }
    if (await changePlant({ action: "create", clientId: crypto.randomUUID(), name: name.slice(0, 80), species: "", location: "", notes: "", intervalDays, lastWateredAt: new Date().toISOString() })) setPlantName("");
  }

  async function removePlant(plant: Plant | SyncedPlant) {
    if ("clientId" in plant) { await changePlant({ action: "delete", clientId: plant.clientId, revision: plant.revision }); return; }
    if (savePlants(localPlants.filter((item) => item.id !== plant.id))) setLastDeletedPlant(plant);
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
  const needsApproval = Boolean(error && (error.includes("not approved") || error.includes("Pair the device again")));

  return <div className="home-overview">
    <div className="home-overview-heading">
      <div><h2>{ru ? "Сегодня" : "Today"}</h2></div>
      <button type="button" onClick={() => void refresh()} disabled={loading} aria-label={ru ? "Обновить обзор" : "Refresh overview"}><Icon name="refresh" size={17} />{ru ? "Обновить" : "Refresh"}</button>
    </div>
    {error && <p className="home-overview-error" role="status">{error} <button type="button" onClick={needsApproval ? () => onNavigate("settings") : () => void refresh()}>{needsApproval ? (ru ? "Обновить разрешения" : "Renew permissions") : (ru ? "Повторить" : "Retry")}</button></p>}
    <div className="home-overview-grid">
      <section className="home-overview-service">
        <div className="home-overview-section-head"><span><Icon name="monitoring" size={20} /></span><div><h3>{ru ? "Сервер и сервисы" : "Server and services"}</h3></div></div>
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
        <p className="home-overview-local">{syncedPlants === null ? (ru ? "Локальный список. Для синхронизации обновите сервер и разрешите plants.manage при подключении." : "Local list. Update the server and approve plants.manage to sync.") : (ru ? "Список синхронизируется с вашим аккаунтом HomePlace." : "Synced with your HomePlace account.")}</p>
        {unimported.length > 0 && <button type="button" className="home-overview-link" disabled={plantsBusy} onClick={() => void importLocalPlants()}>{ru ? `Перенести локальные растения (${unimported.length})` : `Import local plants (${unimported.length})`}</button>}
        {plants.length > 0 ? <div className="home-overview-plant-list">{[...plants].sort((a, b) => daysUntilWater(a, today) - daysUntilWater(b, today)).map((plant) => {
          const days = daysUntilWater(plant, today);
          const remote = "clientId" in plant ? plant : null;
          const local = "id" in plant ? plant : null;
          return <div className="home-overview-plant" key={remote?.clientId ?? local?.id}>
            <span>{remote ? <button type="button" className="home-overview-plant-title" onClick={() => setSelectedPlantId(remote.clientId)}>{plant.name}</button> : <b>{plant.name}</b>}
              <small>{days < 0 ? (ru ? `Просрочено на ${-days} дн.` : `${-days} days overdue`) : days === 0 ? (ru ? "Полить сегодня" : "Water today") : (ru ? `Через ${days} дн.` : `In ${days} days`)}</small></span>
            {remote && plantFeatures?.plantReminders && <button type="button" disabled={plantsBusy} title={ru ? "Включить или выключить напоминания об этом растении" : "Toggle reminders for this plant"} aria-label={`${remote.remindersEnabled === false ? (ru ? "Включить напоминания" : "Enable reminders") : (ru ? "Выключить напоминания" : "Disable reminders")}: ${plant.name}`} aria-pressed={remote.remindersEnabled !== false} onClick={() => void changePlant({ action: "update", clientId: remote.clientId, revision: remote.revision, name: remote.name, species: remote.species, location: remote.location, notes: remote.notes, intervalDays: remote.intervalDays, lastWateredAt: remote.lastWateredAt, remindersEnabled: remote.remindersEnabled === false })}><Icon name="bell" size={15} /></button>}
            <button type="button" disabled={plantsBusy} onClick={() => { if (remote) void changePlant(waterPlantRequest(remote.clientId, remote.revision, new Date().toISOString())); else if (local) savePlants(localPlants.map((item) => item.id === local.id ? { ...item, lastWateredAt: new Date().toISOString() } : item)); }}>{ru ? "Полито" : "Watered"}</button>
            <button type="button" className="home-overview-remove" disabled={plantsBusy} onClick={() => void removePlant(plant)} aria-label={`${ru ? "Удалить" : "Remove"} ${plant.name}`}><Icon name="trash" size={15} /></button>
          </div>;
        })}</div> : <p className="home-overview-empty">{ru ? "Добавьте растение и интервал полива." : "Add a plant and its watering interval."}</p>}
        {syncedPlants === null && lastDeletedPlant && <p className="home-overview-undo" role="status">{ru ? `«${lastDeletedPlant.name}» удалено` : `${lastDeletedPlant.name} removed`} <button type="button" onClick={() => { if (savePlants([...localPlants, lastDeletedPlant])) setLastDeletedPlant(null); }}>{ru ? "Вернуть" : "Undo"}</button></p>}
        <form className="home-overview-plant-form" onSubmit={(event) => void addPlant(event)}><input aria-label={ru ? "Название растения" : "Plant name"} placeholder={ru ? "Название растения" : "Plant name"} value={plantName} onChange={(event) => setPlantName(event.target.value)} maxLength={80} required /><label>{ru ? "Каждые" : "Every"}<input type="number" min={1} max={365} value={intervalDays} onChange={(event) => setIntervalDays(Number(event.target.value))} />{ru ? "дн." : "days"}</label><button type="submit" disabled={plantsBusy || !plantName.trim() || plants.length >= (syncedPlants === null ? 50 : 500)}><Icon name="plus" size={16} />{ru ? "Добавить" : "Add"}</button></form>
        {syncedPlants !== null && plantFeatures?.plantReminders && <PlantReminderSettings language={language} />}
        {plantsError && <p className="home-overview-error" role="alert">{plantsError}</p>}
      </section>
    </div>
    {selectedPlant && plantFeatures && <PlantDetails plant={selectedPlant} features={plantFeatures} language={language} onClose={() => setSelectedPlantId(null)} onChanged={refreshPlants} />}
  </div>;
}
