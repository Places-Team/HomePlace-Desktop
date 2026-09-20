export type DesktopPlatform = "macos" | "windows" | "linux";

export type PlatformInfo = {
  platform: DesktopPlatform;
  label: string;
  secureStorage: string;
  tray: boolean;
  deviceName: string;
  platformVersion: string;
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
    return { platform, label: "Windows", secureStorage: "Credential Manager", tray: true, deviceName: "HomePlace Windows PC", platformVersion: "Unknown" };
  }
  if (platform === "linux") {
    return { platform, label: "Linux", secureStorage: "Secret Service", tray: true, deviceName: "HomePlace Linux PC", platformVersion: "Unknown" };
  }
  return { platform, label: "macOS", secureStorage: "Keychain", tray: true, deviceName: "HomePlace Mac", platformVersion: "Unknown" };
}
