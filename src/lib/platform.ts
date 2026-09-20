export type DesktopPlatform = "macos" | "windows" | "linux";

export type PlatformInfo = {
  platform: DesktopPlatform;
  label: string;
  secureStorage: string;
  tray: boolean;
};

export function platformFromUserAgent(userAgent: string): DesktopPlatform {
  const value = userAgent.toLowerCase();
  if (value.includes("windows")) return "windows";
  if (value.includes("linux")) return "linux";
  return "macos";
}

export function fallbackPlatformInfo(userAgent: string): PlatformInfo {
  const platform = platformFromUserAgent(userAgent);
  if (platform === "windows") {
    return { platform, label: "Windows", secureStorage: "Credential Manager", tray: true };
  }
  if (platform === "linux") {
    return { platform, label: "Linux", secureStorage: "Secret Service", tray: true };
  }
  return { platform, label: "macOS", secureStorage: "Keychain", tray: true };
}
