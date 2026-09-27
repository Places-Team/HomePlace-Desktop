export function filterContainers<T extends { name: string; state?: string; health?: string; image?: string; hostLabel?: string; status?: string }>(items: T[], query: string, problemsOnly: boolean): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter((item) =>
    (!problemsOnly || item.state !== "running" || item.health?.toLowerCase() === "unhealthy") &&
    (!needle || [item.name, item.image, item.hostLabel, item.status].some((value) => value?.toLocaleLowerCase().includes(needle))));
}

export function filterServices<T extends { title: string; status: string }>(items: T[], query: string, problemsOnly: boolean): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter((item) =>
    (!problemsOnly || item.status === "offline") &&
    (!needle || [item.title, item.status].some((value) => value.toLocaleLowerCase().includes(needle))));
}

export function filterEvents<T extends { title: string; detail?: string; severity: string }>(items: T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter((item) => !needle || [item.title, item.detail, item.severity].some((value) => value?.toLocaleLowerCase().includes(needle)));
}

export function filterMediaResults<T extends { kind: string }>(items: T[], filter: "all" | "movies" | "series"): T[] {
  if (filter === "all") return items;
  return items.filter((item) => filter === "series" ? /sonarr/i.test(item.kind) : /radarr/i.test(item.kind));
}
