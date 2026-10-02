type WateringSchedule = { lastWateredAt: string; intervalDays: number };

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

export function photoCacheKey(serverId: string, deviceId: string, plantId: string, version: number): string {
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
