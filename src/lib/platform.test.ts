import { describe, expect, it } from "vitest";
import { fallbackPlatformInfo, platformFromUserAgent } from "./platform";

describe("platform detection", () => {
  it("recognises Windows and Linux user agents", () => {
    expect(platformFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(platformFromUserAgent("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });

  it("uses macOS as the native development fallback", () => {
    expect(fallbackPlatformInfo("Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toEqual({
      platform: "macos",
      label: "macOS",
      secureStorage: "Keychain",
      tray: true,
      deviceName: "HomePlace Mac",
      platformVersion: "Unknown",
    });
  });
});
