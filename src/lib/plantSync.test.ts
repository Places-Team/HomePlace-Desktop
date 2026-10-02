import { describe, expect, it } from "vitest";
import { daysUntilWater, parsePlantReminderSettings, photoCacheKey, plantIdFromNotification, plantSettingsConflict, safePlantPhotoPath, validatePlantPhoto, waterPlantRequest } from "./plantSync";

describe("plant synchronization", () => {
  it("uses local calendar days instead of 24-hour spans around daylight saving changes", () => {
    expect(daysUntilWater({ lastWateredAt: "2026-03-28T23:30:00+01:00", intervalDays: 2 }, new Date("2026-03-30T12:00:00+02:00"), "Europe/Berlin")).toBe(0);
  });

  it("isolates cached photos by server, paired device, plant and revision", () => {
    const first = photoCacheKey("server-a", "device-a", "plant-a", "photo-v2");
    expect(first).not.toBe(photoCacheKey("server-a", "device-b", "plant-a", "photo-v2"));
    expect(first).not.toBe(photoCacheKey("server-a", "device-a", "plant-a", "photo-v3"));
  });

  it("accepts only the private photo path of the selected plant", () => {
    const id = "58c12fbc-4ef5-4bb1-bbac-40af3ebaf6b2";
    expect(safePlantPhotoPath(`/api/link/plants/${id}/photo`, id)).toBe(`/api/link/plants/${id}/photo`);
    expect(safePlantPhotoPath(`https://evil.example/api/link/plants/${id}/photo`, id)).toBeNull();
    expect(safePlantPhotoPath(`/api/link/plants/another/photo`, id)).toBeNull();
    expect(safePlantPhotoPath(`/api/link/plants/${id}/photo?token=secret`, id)).toBeNull();
  });

  it("routes only plant notifications to the matching plant", () => {
    const id = "58c12fbc-4ef5-4bb1-bbac-40af3ebaf6b2";
    expect(plantIdFromNotification(`plant-${id}`)).toBe(id);
    expect(plantIdFromNotification("plant-not-a-uuid")).toBeNull();
    expect(plantIdFromNotification(null)).toBeNull();
  });

  it("uses the dedicated water action without overwriting remote plant details", () => {
    expect(waterPlantRequest("58c12fbc-4ef5-4bb1-bbac-40af3ebaf6b2", 7, "2026-10-03T09:00:00.000Z")).toEqual({
      action: "water",
      clientId: "58c12fbc-4ef5-4bb1-bbac-40af3ebaf6b2",
      revision: 7,
      lastWateredAt: "2026-10-03T09:00:00.000Z",
    });
  });

  it("rejects unsupported or oversized photos before upload", () => {
    expect(validatePlantPhoto({ type: "image/png", size: 1024 }, 2048)).toBeNull();
    expect(validatePlantPhoto({ type: "image/heic", size: 1024 }, 2048)).toBe("unsupported");
    expect(validatePlantPhoto({ type: "image/jpeg", size: 2049 }, 2048)).toBe("too-large");
  });

  it("rejects incomplete or malformed account reminder settings", () => {
    const valid = { enabled: true, app: true, telegram: false, time: "09:00", timeZone: "Europe/Moscow", repeatDays: 2 };
    expect(parsePlantReminderSettings(valid)).toEqual(valid);
    expect(parsePlantReminderSettings({ ...valid, repeatDays: 31 })).toBeNull();
    expect(parsePlantReminderSettings({ ...valid, telegram: "yes" })).toBeNull();
  });

  it("keeps unsaved account settings when another device changes them", () => {
    const before = { enabled: true, app: true, telegram: false, time: "09:00", timeZone: "Europe/Moscow", repeatDays: 1 };
    expect(plantSettingsConflict(before, { ...before, time: "10:00" }, true)).toBe(true);
    expect(plantSettingsConflict(before, { ...before, time: "10:00" }, false)).toBe(false);
    expect(plantSettingsConflict(before, { ...before }, true)).toBe(false);
  });
});
