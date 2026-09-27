import { describe, expect, it } from "vitest";
import { filterContainers, filterEvents, filterMediaResults, filterServices } from "./workspaceFilters";

describe("workspace filters", () => {
  it("finds containers by host and keeps unhealthy running containers in problems", () => {
    const items = [
      { name: "Jellyfin", hostLabel: "media", state: "running", health: "healthy" },
      { name: "Sonarr", hostLabel: "media", state: "running", health: "unhealthy" },
      { name: "Backup", hostLabel: "storage", state: "exited" },
    ];
    expect(filterContainers(items, "MEDIA", true).map((item) => item.name)).toEqual(["Sonarr"]);
    expect(filterContainers(items, "", true).map((item) => item.name)).toEqual(["Sonarr", "Backup"]);
  });

  it("filters services and events without changing the source data", () => {
    const services = [{ title: "Jellyfin", status: "online" }, { title: "Radarr", status: "offline" }];
    const events = [{ title: "Container stopped", detail: "Radarr", severity: "error" }];
    expect(filterServices(services, "raD", true)).toEqual([services[1]]);
    expect(filterEvents(events, "radarr")).toEqual(events);
    expect(services).toHaveLength(2);
  });

  it("separates Radarr movies and Sonarr series", () => {
    const results = [{ kind: "Radarr", title: "Movie" }, { kind: "Sonarr", title: "Series" }];
    expect(filterMediaResults(results, "movies")).toEqual([results[0]]);
    expect(filterMediaResults(results, "series")).toEqual([results[1]]);
    expect(filterMediaResults(results, "all")).toEqual(results);
  });
});
