export type IconName =
  | "home"
  | "devices"
  | "android"
  | "apple"
  | "windows"
  | "linux"
  | "clipboard"
  | "transfer"
  | "automation"
  | "calendar"
  | "bell"
  | "settings"
  | "check"
  | "plus"
  | "link"
  | "focus"
  | "edit"
  | "trash"
  | "refresh"
  | "sun"
  | "moon"
  | "open";

const paths: Record<IconName, ReactNode> = {
  home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v11h14V9" /><path d="M9 20v-6h6v6" /></>,
  devices: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  android: <><path d="M7 9h10v9H7zM8 9a4 4 0 0 1 8 0M9 5 7.5 3M15 5l1.5-2M5 10v6M19 10v6M9 18v3M15 18v3" /><path d="M10 8h.01M14 8h.01" /></>,
  apple: <><path d="M15.4 5.2c-.9.1-2-.6-2.6-1.3-.6-.8-1.1-1.9-.9-3 1 .1 2 .7 2.6 1.4.6.7 1.1 1.8.9 2.9Z" /><path d="M18.8 12.9c0-2.7 2.2-4 2.3-4.1-1.3-1.9-3.3-2.1-4-2.1-1.7-.2-3.3 1-4.2 1-.9 0-2.2-1-3.7-.9-1.9 0-3.7 1.1-4.7 2.8-2 3.5-.5 8.7 1.4 11.5.9 1.4 2.1 2.9 3.6 2.8 1.4-.1 2-1 3.7-1 1.7 0 2.2 1 3.7 1 1.5 0 2.5-1.4 3.5-2.8 1.1-1.6 1.6-3.2 1.6-3.3-.1 0-3.2-1.2-3.2-4.9Z" transform="scale(.78) translate(3 2)" /></>,
  windows: <><path d="M3 5.5 11 4.4v7.1H3V5.5ZM13 4.1 21 3v8.5h-8V4.1ZM3 13h8v7.1L3 19v-6ZM13 13h8v8l-8-1.1V13Z" /></>,
  linux: <><path d="M9 8c0-3 1-5 3-5s3 2 3 5c2 1 3 3 3 6 0 4-2 7-6 7s-6-3-6-7c0-3 1-5 3-6Z" /><path d="M9 14c1 1 5 1 6 0M10 8h.01M14 8h.01M11 11h2" /></>,
  clipboard: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4.5V3h6v1.5M9 9h6M9 13h6M9 17h4" /></>,
  transfer: <><path d="M4 7h14M14 3l4 4-4 4" /><path d="M20 17H6M10 13l-4 4 4 4" /></>,
  automation: <><path d="m13 2-9 12h7l-1 8 9-12h-7l1-8Z" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /><path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.17.36.44.66.8.86.33.18.7.28 1.08.28H21v4h-.1A1.7 1.7 0 0 0 19.4 15Z" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  link: <><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></>,
  focus: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>,
  edit: <><path d="M4 20h4l11-11-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14" /><path d="M10 11v6M14 11v6" /></>,
  refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 9a7 7 0 0 1 11.4-2L20 9M4 15l2.5 2A7 7 0 0 0 18 15" /></>,
  sun: <><circle cx="12" cy="12" r="3.5" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" /></>,
  moon: <path d="M20.4 15.2A8.4 8.4 0 0 1 8.8 3.6 8.6 8.6 0 1 0 20.4 15.2Z" />,
  open: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></>,
};

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
import type { ReactNode } from "react";
