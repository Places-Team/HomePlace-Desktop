type WateringSchedule = { lastWateredAt: string; intervalDays: number };

export type SyncedPlant = {
  clientId: string;
  name: string;
  species: string;
  location: string;
  notes: string;
  intervalDays: number;
  lastWateredAt: string;
  remindersEnabled?: boolean;
  revision: number;
  deletedAt: string | null;
  photo?: { url: string; version: string; maxBytes: number } | null;
};

export type PlantFeatures = { plants: boolean; plantPhotos: boolean; plantReminders: boolean; maxPlantPhotoBytes: number };
export type PlantReminderSettings = { enabled: boolean; app: boolean; telegram: boolean; time: string; timeZone: string; repeatDays: number };

function calendarDay(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (part: string) => Number(parts.find((item) => item.type === part)?.value);
  return Date.UTC(value("year"), value("month") - 1, value("day")) / 86_400_000;
}

export function daysUntilWater(plant: WateringSchedule, today: Date, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): number {
  return calendarDay(new Date(plant.lastWateredAt), timeZone) + plant.intervalDays - calendarDay(today, timeZone);
}

export function photoCacheKey(serverId: string, deviceId: string, plantId: string, version: string): string {
  return JSON.stringify([serverId, deviceId, plantId, version]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function safePlantPhotoPath(path: string, plantId: string): string | null {
  if (!UUID.test(plantId)) return null;
  const expected = `/api/link/plants/${plantId}/photo`;
  return path === expected ? path : null;
}

export function plantIdFromNotification(tag: string | null | undefined): string | null {
  const id = tag?.startsWith("plant-") ? tag.slice(6) : "";
  return UUID.test(id) ? id : null;
}

export function waterPlantRequest(clientId: string, revision: number, lastWateredAt: string) {
  return { action: "water" as const, clientId, revision, lastWateredAt };
}

export function validatePlantPhoto(file: { type: string; size: number }, maxBytes: number): "unsupported" | "too-large" | null {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return "unsupported";
  if (!Number.isFinite(file.size) || file.size < 1 || file.size > maxBytes) return "too-large";
  return null;
}

export function parsePlantReminderSettings(value: unknown): PlantReminderSettings | null {
  if (typeof value !== "object" || value === null) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.enabled !== "boolean" || typeof data.app !== "boolean" || typeof data.telegram !== "boolean" ||
    typeof data.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time) ||
    typeof data.timeZone !== "string" || data.timeZone.length > 80 ||
    !Number.isInteger(data.repeatDays) || (data.repeatDays as number) < 0 || (data.repeatDays as number) > 30) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: data.timeZone }); }
  catch { return null; }
  return data as PlantReminderSettings;
}

export function plantSettingsConflict(previous: PlantReminderSettings, incoming: PlantReminderSettings, hasUnsavedEdits: boolean): boolean {
  return hasUnsavedEdits && (previous.enabled !== incoming.enabled || previous.app !== incoming.app ||
    previous.telegram !== incoming.telegram || previous.time !== incoming.time ||
    previous.timeZone !== incoming.timeZone || previous.repeatDays !== incoming.repeatDays);
}
