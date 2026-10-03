import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FormEvent, Fragment, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./components/Icon";
import { IdeasBoard } from "./components/IdeasBoard";
import { HomeOverview } from "./components/HomeOverview";
import { NotificationHistory } from "./components/NotificationHistory";
import { ServerWorkspace } from "./components/ServerWorkspace";
import { MediaCatalog } from "./components/MediaCatalog";
import { TelegramStatus } from "./components/TelegramStatus";
import { TemporaryExchange, type ExchangeContent } from "./components/TemporaryExchange";
import { exchangeExpiryOptions, exchangeGateway } from "./lib/exchangeGateway";
import { copy, type Language } from "./lib/i18n";
import { fallbackPlatformInfo, type PlatformInfo } from "./lib/platform";
import { fileLimitLabel, useFileTransferLimit } from "./lib/useFileTransferLimit";
import { QuickShareLifecycle } from "./lib/quickShareLifecycle";

type ConnectionState =
  | "not-configured"
  | "verifying"
  | "verified"
  | "requesting"
  | "pairing"
  | "connected";

type ThemeMode = "dark" | "light";
const isTauriRuntime = "__TAURI_INTERNALS__" in window;

function storedTheme(): ThemeMode {
  const saved = window.localStorage.getItem("homeplace-theme");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

type VerifiedServer = {
  address: string;
  serverId: string;
  serverName: string;
  realtime: boolean;
  reducedSecurity: boolean;
};

type PairingSession = {
  code: string;
  expiresAt: string;
  pollAfterSeconds: number;
};

type PairingStatus = {
  status: "pending" | "approved" | "rejected" | "expired";
  deviceId?: string;
};

type ConnectionProfile = {
  serverId: string;
  serverName: string;
  address: string;
  deviceId: string;
  deviceName: string;
  fileBatchApproved?: boolean;
};

type ConnectionProfiles = {
  profiles: ConnectionProfile[];
  activeServerId?: string;
};

type HeartbeatUpdate =
  | {
      status: "connected";
      serverTime: string;
      pendingEvents: number;
      deliveredNotifications: number;
      notificationFailures: number;
      offers: ShareOfferSummary[];
    }
  | { status: "failed"; message: string };

type ShareOfferSummary = {
  id: string;
  kind: "url" | "text" | "file";
  sourceName: string;
  sentAt: string;
  filename?: string | null;
  size?: number | null;
};

type TransferHistoryItem = ShareOfferSummary & {
  action: "open" | "copy" | "save" | "decline";
  resolvedAt: string;
};

type StartupStatus = {
  enabled: boolean;
};

type ClipboardSyncStatus = {
  enabled: boolean;
};

type SystemNotificationStatus = {
  enabled: boolean;
};

type ClipboardHistoryEntry = {
  id: string;
  text: string;
  direction: "sent" | "received";
  createdAt: string;
};

type ShareTarget = {
  id: string;
  name: string;
  platform: string;
  supportsText: boolean;
  supportsUrl: boolean;
  supportsFile: boolean;
  online: boolean;
  ownerName: string;
  ownedByCurrentUser: boolean;
};

type AccountDevice = {
  id: string;
  name: string;
  platform: string;
  platformVersion: string;
  appVersion: string;
  online: boolean;
  lastSeenAt?: string | null;
  ownerName: string;
  currentDevice: boolean;
};

type QuickSharePayload =
  | { kind: "files"; paths: string[]; label: string }
  | { kind: "text" | "url"; value: string; label: string };

type FileTransferProgress = {
  transferId: string;
  fileName: string;
  transferredBytes: number;
  totalBytes: number;
};

type FileBatchProgress = {
  batchId: string;
  fileName: string;
  fileIndex: number;
  fileCount: number;
  transferredBytes: number;
  totalBytes: number;
};

type ShareBatch = {
  id: string;
  status: "assembling" | "offered" | "accepted" | "completed" | "rejected" | "canceled";
  sourceDeviceId: string;
  targetDeviceId: string;
  expiresAt: string;
  files: { id: string; filename: string; size: number; received: boolean; downloadedBytes: number }[];
};

type LocalBatchSummary = { requestKey: string; batchId: string | null; targetDeviceId: string; fileCount: number; sending: boolean };

type ActiveTransferProgress = FileTransferProgress & {
  fileIndex: number;
  fileCount: number;
  targetName: string;
};

type PendingNativeShare = {
  files: string[];
  text?: string | null;
};

type ExchangeStage = { text?: string | null; filePath?: string | null };

type Reminder = {
  id: string;
  title: string;
  at: string;
  repeat: string;
};

type CompletedReminder = Reminder & {
  completedAt: string | null;
};

type ReminderBucket = "overdue" | "today" | "upcoming";

type CalendarEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
};

type CalendarSummary = {
  status: "connected" | "not_connected" | "unavailable";
  events: CalendarEvent[];
};

type AppSection =
  | "overview"
  | "devices"
  | "clipboard"
  | "transfers"
  | "automations"
  | "productivity"
  | "media"
  | "monitoring"
  | "notifications"
  | "settings";

type ContextAction = {
  label: string;
  icon: IconName;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
};

type ContextMenuState = {
  x: number;
  y: number;
  actions: ContextAction[];
};

const navigation: Array<{
  id: AppSection;
  icon: IconName;
}> = [
  { id: "overview", icon: "home" },
  { id: "productivity", icon: "calendar" },
  { id: "media", icon: "media" },
  { id: "monitoring", icon: "monitoring" },
  { id: "devices", icon: "devices" },
  { id: "transfers", icon: "transfer" },
  { id: "clipboard", icon: "clipboard" },
  { id: "notifications", icon: "bell" },
  { id: "automations", icon: "automation" },
  { id: "settings", icon: "settings" },
];

function errorMessage(error: unknown): string {
  return typeof error === "string" && error.trim()
    ? error
    : "The HomePlace request could not be completed.";
}

function deviceCountLabel(count: number, language: Language): string {
  if (language === "en") return `${count} ${count === 1 ? "device" : "devices"}`;
  const remainder100 = count % 100;
  const remainder10 = count % 10;
  const noun = remainder100 >= 11 && remainder100 <= 14
    ? "устройств"
    : remainder10 === 1
      ? "устройство"
      : remainder10 >= 2 && remainder10 <= 4
        ? "устройства"
        : "устройств";
  return `${count} ${noun}`;
}

function newTransferId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function formatTransferBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1)} MiB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KiB`;
  return `${value} B`;
}

function TransferProgressRing({ progress, compact = false }: { progress: ActiveTransferProgress; compact?: boolean }) {
  const preparing = progress.totalBytes <= 0;
  const percent = progress.totalBytes > 0
    ? Math.min(100, Math.round((progress.transferredBytes / progress.totalBytes) * 100))
    : 0;
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  return (
    <span className={`transfer-progress-ring${compact ? " compact" : ""}${preparing ? " preparing" : ""}`} aria-label={preparing ? "Preparing transfer" : `${percent}%`}>
      <svg viewBox="0 0 48 48" aria-hidden>
        <circle className="transfer-progress-track" cx="24" cy="24" r={radius} />
        <circle
          className="transfer-progress-value"
          cx="24"
          cy="24"
          r={radius}
          style={{ strokeDasharray: circumference, strokeDashoffset: circumference * (1 - percent / 100) }}
        />
      </svg>
      <strong>{preparing ? "…" : percent}{!preparing && <small>%</small>}</strong>
    </span>
  );
}

function TransferProgressPanel({ progress, language }: { progress: ActiveTransferProgress; language: Language }) {
  const preparing = progress.totalBytes <= 0;
  const percent = progress.totalBytes > 0
    ? Math.min(100, Math.round((progress.transferredBytes / progress.totalBytes) * 100))
    : 0;
  return (
    <div className={`file-transfer-progress${preparing ? " preparing" : ""}${percent === 100 ? " finalizing" : ""}`} role="status" aria-live="polite">
      <TransferProgressRing progress={progress} />
      <div className="file-transfer-progress-copy">
        <b>{language === "ru" ? `Отправка на ${progress.targetName}` : `Sending to ${progress.targetName}`}</b>
        <span>{progress.fileName}</span>
        <div className="file-transfer-progress-line"><i style={{ width: `${percent}%` }} /></div>
        <small>{preparing
          ? (language === "ru" ? "Подготовка защищённой передачи…" : "Preparing secure transfer…")
          : <>{formatTransferBytes(progress.transferredBytes)} / {formatTransferBytes(progress.totalBytes)}{progress.fileCount > 1 && ` · ${progress.fileIndex + 1}/${progress.fileCount}`}</>}
        </small>
      </div>
    </div>
  );
}

function progressIndex(state: ConnectionState): number {
  if (state === "connected") return 3;
  if (state === "requesting" || state === "pairing") return 2;
  if (state === "verifying" || state === "verified") return 1;
  return 0;
}

function serverFromProfile(profile: ConnectionProfile): VerifiedServer {
  return {
    address: profile.address,
    serverId: profile.serverId,
    serverName: profile.serverName,
    realtime: false,
    reducedSecurity: profile.address.startsWith("http://"),
  };
}

function defaultReminderTime(): string {
  const value = new Date();
  value.setHours(value.getHours() + 1, 0, 0, 0);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function localDayKey(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function calendarEventDay(event: CalendarEvent): string {
  return event.allDay ? event.start : localDayKey(new Date(event.start));
}

function localDateTimeInput(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${localDayKey(value)}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function visibleCalendarRange(monthOffset: number): { from: string; to: string } {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 42);
  return { from: start.toISOString(), to: end.toISOString() };
}

function accountDeviceIcon(platformName: string): IconName {
  const value = platformName.toLowerCase();
  if (value.includes("android")) return "android";
  if (value.includes("mac") || value.includes("ios")) return "apple";
  if (value.includes("win")) return "windows";
  if (value.includes("linux")) return "linux";
  return "devices";
}

export function App() {
  const windowLabel = isTauriRuntime ? getCurrentWindow().label : "main";
  useLayoutEffect(() => {
    document.documentElement.dataset.window = windowLabel;
    document.documentElement.dataset.theme = storedTheme();
  }, [windowLabel]);
  return windowLabel === "quick-share" ? <QuickShareWindow /> : <MainApp />;
}

function MainApp() {
  const [activeSection, setActiveSection] = useState<AppSection>("overview");
  const [requestedPlantId, setRequestedPlantId] = useState<string | null>(null);
  const [transferMode, setTransferMode] = useState<"devices" | "exchange">("devices");
  const [exchangeDraft, setExchangeDraft] = useState<{ revision: number; serverId: string | null; content: ExchangeContent } | null>(null);
  const [sidebarPinned, setSidebarPinned] = useState(() => window.localStorage.getItem("homeplace-sidebar-pinned") === "1");
  const [sidebarExpanded, setSidebarExpanded] = useState(sidebarPinned);
  const [theme, setTheme] = useState<ThemeMode>(storedTheme);
  const [language, setLanguage] = useState<Language>(() => {
    const saved = window.localStorage.getItem("homeplace-language");
    if (saved === "en" || saved === "ru") return saved;
    return navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
  });
  const [platform, setPlatform] = useState<PlatformInfo>(() =>
    fallbackPlatformInfo(navigator.userAgent),
  );
  const [state, setState] = useState<ConnectionState>("not-configured");
  const [address, setAddress] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [server, setServer] = useState<VerifiedServer | null>(null);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [pairing, setPairing] = useState<PairingSession | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastHeartbeat, setLastHeartbeat] = useState<Date | null>(null);
  const [heartbeatError, setHeartbeatError] = useState<string | null>(null);
  const [pendingEvents, setPendingEvents] = useState(0);
  const [deliveredNotifications, setDeliveredNotifications] = useState(0);
  const [notificationFailures, setNotificationFailures] = useState(0);
  const [offers, setOffers] = useState<ShareOfferSummary[]>([]);
  const [shareBatches, setShareBatches] = useState<ShareBatch[]>([]);
  const [localBatches, setLocalBatches] = useState<LocalBatchSummary[]>([]);
  const [batchBusy, setBatchBusy] = useState<string | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [offerBusy, setOfferBusy] = useState<string | null>(null);
  const [offerError, setOfferError] = useState<string | null>(null);
  const [dismissedOfferId, setDismissedOfferId] = useState<string | null>(null);
  const [transferHistory, setTransferHistory] = useState<TransferHistoryItem[]>(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem("homeplace-transfer-history") ?? "[]") as unknown;
      return Array.isArray(stored) ? (stored as TransferHistoryItem[]).slice(0, 50) : [];
    } catch {
      return [];
    }
  });
  const [reconnecting, setReconnecting] = useState(false);
  const [startupEnabled, setStartupEnabled] = useState(false);
  const [startupLoaded, setStartupLoaded] = useState(false);
  const [startupBusy, setStartupBusy] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [clipboardSyncEnabled, setClipboardSyncEnabled] = useState(false);
  const [clipboardSyncLoaded, setClipboardSyncLoaded] = useState(false);
  const [clipboardSyncBusy, setClipboardSyncBusy] = useState(false);
  const [clipboardHistory, setClipboardHistory] = useState<ClipboardHistoryEntry[]>([]);
  const [clipboardHistoryError, setClipboardHistoryError] = useState<string | null>(null);
  const [clipboardSyncError, setClipboardSyncError] = useState<string | null>(null);
  const [systemNotificationsEnabled, setSystemNotificationsEnabled] = useState(true);
  const [systemNotificationsLoaded, setSystemNotificationsLoaded] = useState(false);
  const [systemNotificationsBusy, setSystemNotificationsBusy] = useState(false);
  const [systemNotificationsError, setSystemNotificationsError] = useState<string | null>(null);
  const [accountDevices, setAccountDevices] = useState<AccountDevice[]>([]);
  const [accountDevicesLoaded, setAccountDevicesLoaded] = useState(false);
  const [accountDevicesError, setAccountDevicesError] = useState<string | null>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [completedReminders, setCompletedReminders] = useState<CompletedReminder[]>([]);
  const [remindersLoaded, setRemindersLoaded] = useState(true);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [reminderError, setReminderError] = useState<string | null>(null);
  const [addingReminder, setAddingReminder] = useState(false);
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderAt, setReminderAt] = useState(defaultReminderTime);
  const [reminderRepeat, setReminderRepeat] = useState("none");
  const [editingReminderId, setEditingReminderId] = useState<string | null>(null);
  const [expandedReminderIds, setExpandedReminderIds] = useState<Set<string>>(() => new Set());
  const [draggedReminderId, setDraggedReminderId] = useState<string | null>(null);
  const [reminderDropTarget, setReminderDropTarget] = useState<ReminderBucket | null>(null);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarStatus, setCalendarStatus] = useState<CalendarSummary["status"]>("not_connected");
  const [calendarLoaded, setCalendarLoaded] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [calendarMonthOffset, setCalendarMonthOffset] = useState(0);
  const [selectedCalendarDay, setSelectedCalendarDay] = useState(() => localDayKey(new Date()));
  const [editingCalendarEventId, setEditingCalendarEventId] = useState<string | null>(null);
  const [showCalendarForm, setShowCalendarForm] = useState(false);
  const [calendarTitle, setCalendarTitle] = useState("");
  const [calendarStart, setCalendarStart] = useState("");
  const [calendarEnd, setCalendarEnd] = useState("");
  const [calendarAllDay, setCalendarAllDay] = useState(false);
  const [calendarLocation, setCalendarLocation] = useState("");
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const contextLabels = language === "ru"
    ? {
        open: "Открыть",
        quickShare: "Быстрая отправка",
        reconnect: "Переподключиться",
        copyAddress: "Скопировать адрес",
        copy: "Скопировать",
        send: "Отправить на устройство",
        accept: "Принять",
        decline: "Отклонить",
        edit: "Изменить",
        complete: "Выполнить",
        restore: "Вернуть в активные",
        expand: "Открыть полностью",
        collapse: "Свернуть",
        moveToday: "Перенести на сегодня",
        moveUpcoming: "Перенести в предстоящие",
        snoozeTen: "Отложить на 10 минут",
        snoozeHour: "Отложить на час",
        tomorrow: "Перенести на завтра",
        duplicate: "Создать копию",
        remove: "Удалить",
        clear: "Очистить историю",
        close: "Закрыть меню",
      }
    : {
        open: "Open",
        quickShare: "Quick share",
        reconnect: "Reconnect",
        copyAddress: "Copy address",
        copy: "Copy",
        send: "Send to a device",
        accept: "Accept",
        decline: "Decline",
        edit: "Edit",
        complete: "Complete",
        restore: "Restore to active",
        expand: "Open full text",
        collapse: "Collapse",
        moveToday: "Move to today",
        moveUpcoming: "Move to upcoming",
        snoozeTen: "Snooze for 10 minutes",
        snoozeHour: "Snooze for 1 hour",
        tomorrow: "Move to tomorrow",
        duplicate: "Duplicate",
        remove: "Delete",
        clear: "Clear history",
        close: "Close menu",
      };

  function openContextMenu(event: ReactMouseEvent, actions: ContextAction[]) {
    event.preventDefault();
    event.stopPropagation();
    const width = 238;
    const height = actions.length * 38 + 12;
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
      actions,
    });
  }

  function openQuickShare(text?: string) {
    void invoke("open_quick_share", { text: text || null }).catch((reason) => {
      setOfferError(errorMessage(reason));
    });
  }

  useEffect(() => {
    invoke<PlatformInfo>("platform_info")
      .then((info) => {
        setPlatform(info);
        setDeviceName((current) => current || info.deviceName);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    invoke<ConnectionProfiles>("connection_profiles")
      .then((collection) => {
        if (cancelled) return;
        setProfiles(collection.profiles);
        setActiveServerId(collection.activeServerId ?? null);
        const active = collection.profiles.find(
          (profile) => profile.serverId === collection.activeServerId,
        );
        if (!active) return;
        setAddress(active.address);
        setDeviceName(active.deviceName);
        setServer(serverFromProfile(active));
        setState("connected");
      })
      .catch((reason) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setProfilesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.platform = platform.platform;
  }, [platform.platform]);

  useEffect(() => {
    window.localStorage.setItem("homeplace-language", language);
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    window.localStorage.setItem("homeplace-theme", theme);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!isTauriRuntime) return;
    let cancelled = false;
    let stopListening: (() => void) | undefined;
    void listen<string>("navigate-section", ({ payload }) => {
      const section = navigation.find((item) => item.id === payload)?.id;
      if (!cancelled && section) setActiveSection(section);
    }).then((unlisten) => {
      if (cancelled) unlisten(); else stopListening = unlisten;
    });
    return () => {
      cancelled = true;
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;
    let cancelled = false;
    let stopListening: (() => void) | undefined;
    void listen<ExchangeStage>("exchange-stage", ({ payload }) => {
      if (cancelled) return;
      const content: ExchangeContent | null = payload.filePath
        ? { kind: "file", path: payload.filePath, name: payload.filePath.split(/[\\/]/).pop() || payload.filePath }
        : payload.text
          ? { kind: "text", text: payload.text }
          : null;
      if (!content) return;
      setExchangeDraft((previous) => ({ revision: (previous?.revision ?? 0) + 1, serverId: activeServerId, content }));
      setTransferMode("exchange");
      setActiveSection("transfers");
    }).then((unlisten) => {
      if (cancelled) unlisten(); else stopListening = unlisten;
    });
    return () => { cancelled = true; stopListening?.(); };
  }, [activeServerId]);

  useEffect(() => {
    if (!isTauriRuntime || activeSection !== "transfers" || transferMode !== "exchange") return;
    let cancelled = false;
    let stopDrop: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled || event.payload.type !== "drop") return;
      const path = event.payload.paths[0];
      if (!path) return;
      setExchangeDraft((previous) => ({
        revision: (previous?.revision ?? 0) + 1,
        serverId: activeServerId,
        content: { kind: "file", path, name: path.split(/[\\/]/).pop() || path },
      }));
    }).then((unlisten) => {
      if (cancelled) unlisten(); else stopDrop = unlisten;
    });
    return () => { cancelled = true; stopDrop?.(); };
  }, [activeSection, transferMode, activeServerId]);

  useEffect(() => {
    window.localStorage.setItem("homeplace-transfer-history", JSON.stringify(transferHistory.slice(0, 50)));
  }, [transferHistory]);

  useEffect(() => {
    if (activeSection !== "clipboard") return;
    void invoke<ClipboardHistoryEntry[]>("clipboard_history")
      .then((entries) => {
        setClipboardHistory(entries);
        setClipboardHistoryError(null);
      })
      .catch((reason) => setClipboardHistoryError(errorMessage(reason)));
  }, [activeSection, lastHeartbeat]);

  useEffect(() => {
    if (!isTauriRuntime || activeSection !== "clipboard") return;
    let cancelled = false;
    let stopListening: (() => void) | undefined;
    void listen("clipboard-history-changed", () => {
      void invoke<ClipboardHistoryEntry[]>("clipboard_history")
        .then((entries) => {
          if (!cancelled) {
            setClipboardHistory(entries);
            setClipboardHistoryError(null);
          }
        })
        .catch((reason) => {
          if (!cancelled) setClipboardHistoryError(errorMessage(reason));
        });
    }).then((unlisten) => {
      if (cancelled) unlisten(); else stopListening = unlisten;
    });
    return () => {
      cancelled = true;
      stopListening?.();
    };
  }, [activeSection]);

  useEffect(() => {
    if (!isTauriRuntime) return;
    let cancelled = false;
    let stopListening: (() => void) | undefined;
    void listen<string>("link-profile-changed", () => {
      void invoke<ConnectionProfiles>("connection_profiles")
        .then((collection) => {
          if (cancelled) return;
          const active = collection.profiles.find(
            (profile) => profile.serverId === collection.activeServerId,
          );
          setProfiles(collection.profiles);
          setActiveServerId(collection.activeServerId ?? null);
          setLastHeartbeat(null);
          setHeartbeatError(null);
          setPendingEvents(0);
          setDeliveredNotifications(0);
          setNotificationFailures(0);
          setOffers([]);
          setOfferError(null);
          if (active) {
            setAddress(active.address);
            setDeviceName(active.deviceName);
            setServer(serverFromProfile(active));
            setPairing(null);
            setError(null);
            setState("connected");
          }
        })
        .catch((reason) => {
          if (!cancelled) setHeartbeatError(errorMessage(reason));
        });
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        stopListening = unlisten;
      }
    });
    return () => {
      cancelled = true;
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    if (state !== "pairing" || !pairing || !server) return;

    const timer = window.setTimeout(async () => {
      try {
        const result = await invoke<PairingStatus>("poll_pairing", {
          serverId: server.serverId,
        });
        if (result.status === "approved") {
          const collection = await invoke<ConnectionProfiles>(
            "connection_profiles",
          );
          const active = collection.profiles.find(
            (profile) => profile.serverId === collection.activeServerId,
          );
          setProfiles(collection.profiles);
          setActiveServerId(collection.activeServerId ?? null);
          if (active) {
            setAddress(active.address);
            setDeviceName(active.deviceName);
            setServer(serverFromProfile(active));
          }
          setPairing(null);
          setError(null);
          setState("connected");
          return;
        }
        if (result.status === "rejected" || result.status === "expired") {
          setError(
            result.status === "rejected"
              ? "The pairing request was rejected in HomePlace."
              : "The pairing request expired. Start a new request.",
          );
          setPairing(null);
          setState("verified");
          return;
        }
        setError(null);
        setPollAttempt((attempt) => attempt + 1);
      } catch (reason) {
        setError(errorMessage(reason));
        setPollAttempt((attempt) => attempt + 1);
      }
    }, pairing.pollAfterSeconds * 1000);

    return () => window.clearTimeout(timer);
  }, [pairing, pollAttempt, server, state]);

  useEffect(() => {
    if (!isTauriRuntime || !activeServerId) return;
    let cancelled = false;
    async function reload() {
      try {
        const [incoming, pending] = await Promise.all([
          invoke<ShareBatch[]>("list_share_batches"),
          invoke<LocalBatchSummary[]>("list_local_share_batches"),
        ]);
        if (!cancelled) {
          setShareBatches(incoming);
          setLocalBatches(pending);
          setBatchError(null);
        }
      } catch (reason) {
        if (!cancelled && activeSection === "transfers") setBatchError(errorMessage(reason));
      }
    }
    void reload();
    const timer = window.setInterval(() => void reload(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeServerId, activeSection]);

  useEffect(() => {
    if (!isTauriRuntime || !activeServerId) return;
    let cancelled = false;
    let stopListening: (() => void) | undefined;

    function wake() {
      if (document.visibilityState === "hidden") return;
      void invoke("request_heartbeat");
    }

    void listen<HeartbeatUpdate>("link-heartbeat", ({ payload }) => {
      if (cancelled) return;
      if (payload.status === "failed") {
        setHeartbeatError(payload.message);
        return;
      }
      setLastHeartbeat(new Date(payload.serverTime));
      setPendingEvents(payload.pendingEvents);
      setDeliveredNotifications(payload.deliveredNotifications);
      setNotificationFailures(payload.notificationFailures);
      setOffers(payload.offers);
      setOfferError(null);
      setHeartbeatError(null);
    })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        stopListening = unlisten;
        void invoke("request_heartbeat");
      })
      .catch((reason) => {
        if (!cancelled) setHeartbeatError(errorMessage(reason));
      });

    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      cancelled = true;
      stopListening?.();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [activeServerId]);

  useEffect(() => {
    if (!activeServerId || activeSection !== "productivity" || calendarBusy) return;
    let cancelled = false;
    let inFlight = false;
    const range = visibleCalendarRange(calendarMonthOffset);
    function refresh() {
      if (cancelled || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      invoke<CalendarSummary>("list_calendar_events", range)
        .then((result) => {
          if (cancelled) return;
          setCalendarEvents(result.events);
          setCalendarStatus(result.status);
          setCalendarError(null);
        })
        .catch((reason) => {
          if (!cancelled) setCalendarError(errorMessage(reason));
        })
        .finally(() => {
          inFlight = false;
          if (!cancelled) setCalendarLoaded(true);
        });
    }
    void refresh();
    const timer = window.setInterval(refresh, 45_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [activeServerId, activeSection, calendarBusy, calendarMonthOffset]);

  useEffect(() => {
    if (!activeServerId || activeSection !== "productivity" || reminderBusy) return;
    let cancelled = false;
    let inFlight = false;
    function refresh() {
      if (cancelled || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      Promise.allSettled([
        invoke<Reminder[]>("list_reminders"),
        invoke<CompletedReminder[]>("list_completed_reminders"),
      ]).then(([active, completed]) => {
        if (cancelled) return;
        if (active.status === "fulfilled") setReminders(active.value);
        if (completed.status === "fulfilled") setCompletedReminders(completed.value);
        const failure = active.status === "rejected" ? active.reason : completed.status === "rejected" ? completed.reason : null;
        setReminderError(failure === null ? null : errorMessage(failure));
        setRemindersLoaded(true);
      }).finally(() => { inFlight = false; });
    }
    void refresh();
    const timer = window.setInterval(refresh, 45_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [activeServerId, activeSection, reminderBusy]);

  useEffect(() => {
    if (!activeServerId || activeSection !== "devices") return;
    let cancelled = false;
    let inFlight = false;
    function refresh() {
      if (cancelled || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      invoke<AccountDevice[]>("list_account_devices")
        .then((items) => {
          if (cancelled) return;
          setAccountDevices(items);
          setAccountDevicesError(null);
        })
        .catch((reason) => {
          if (!cancelled) setAccountDevicesError(errorMessage(reason));
        })
        .finally(() => {
          inFlight = false;
          if (!cancelled) setAccountDevicesLoaded(true);
        });
    }
    void refresh();
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [activeServerId, activeSection]);

  useEffect(() => {
    if (!activeServerId) return;
    let cancelled = false;
    invoke<SystemNotificationStatus>("system_notification_status")
      .then((status) => {
        if (!cancelled) setSystemNotificationsEnabled(status.enabled);
      })
      .catch((reason) => {
        if (!cancelled) setSystemNotificationsError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setSystemNotificationsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [activeServerId]);

  useEffect(() => {
    if (!activeServerId) return;
    let cancelled = false;
    invoke<ClipboardSyncStatus>("clipboard_sync_status")
      .then((status) => {
        if (!cancelled) setClipboardSyncEnabled(status.enabled);
      })
      .catch((reason) => {
        if (!cancelled) setClipboardSyncError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setClipboardSyncLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [activeServerId]);

  useEffect(() => {
    if (!activeServerId) return;
    let cancelled = false;
    invoke<StartupStatus>("startup_status")
      .then((status) => {
        if (!cancelled) setStartupEnabled(status.enabled);
      })
      .catch((reason) => {
        if (!cancelled) setStartupError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setStartupLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [activeServerId]);

  const current = progressIndex(state);
  const busy = state === "verifying" || state === "requesting" || profileBusy;
  const isAddingServer = state !== "connected" && profiles.length > 0;
  const ui = copy[language];
  const today = new Date();
  const calendarView = new Date(today.getFullYear(), today.getMonth() + calendarMonthOffset, 1);
  const monthLabel = calendarView.toLocaleDateString(language === "ru" ? "ru-RU" : "en-US", {
    month: "long",
    year: "numeric",
  });
  const firstDay = calendarView;
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const calendarDays = Array.from({ length: 42 }, (_, index) => {
    const value = new Date(
      calendarView.getFullYear(),
      calendarView.getMonth(),
      index - mondayOffset + 1,
    );
    return {
      key: localDayKey(value),
      day: value.getDate(),
      currentMonth: value.getMonth() === calendarView.getMonth(),
      isToday: value.toDateString() === today.toDateString(),
      eventCount: calendarEvents.filter((event) => calendarEventDay(event) === localDayKey(value)).length,
    };
  });
  const selectedCalendarEvents = calendarEvents
    .filter((event) => calendarEventDay(event) === selectedCalendarDay)
    .sort((left, right) => left.start.localeCompare(right.start));
  const selectedCalendarDate = new Date(`${selectedCalendarDay}T12:00:00`);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const reminderTime = (reminder: Reminder) => new Date(reminder.at).getTime();
  const byReminderTime = (left: Reminder, right: Reminder) => reminderTime(left) - reminderTime(right);
  const overdueReminders = reminders
    .filter((reminder) => reminderTime(reminder) < today.getTime())
    .sort(byReminderTime);
  const todayReminders = reminders.filter((reminder) => {
    const at = new Date(reminder.at);
    return at >= today && at < startOfTomorrow;
  }).sort(byReminderTime);
  const upcomingReminders = reminders
    .filter((reminder) => new Date(reminder.at) >= startOfTomorrow)
    .sort(byReminderTime);

  function clearConnectionHealth() {
    setLastHeartbeat(null);
    setHeartbeatError(null);
    setPendingEvents(0);
    setDeliveredNotifications(0);
    setNotificationFailures(0);
    setOffers([]);
    setOfferError(null);
    setAccountDevices([]);
    setAccountDevicesLoaded(true);
    setAccountDevicesError(null);
    setReminders([]);
    setCompletedReminders([]);
    setCalendarEvents([]);
    setCalendarStatus("not_connected");
    setCalendarLoaded(false);
    setCalendarError(null);
  }

  function showProfile(profile: ConnectionProfile) {
    setAddress(profile.address);
    setDeviceName(profile.deviceName);
    setServer(serverFromProfile(profile));
    setPairing(null);
    setError(null);
    setState("connected");
  }

  async function reloadProfiles() {
    const collection = await invoke<ConnectionProfiles>("connection_profiles");
    setProfiles(collection.profiles);
    setActiveServerId(collection.activeServerId ?? null);
    const active = collection.profiles.find(
      (profile) => profile.serverId === collection.activeServerId,
    );
    if (active) {
      showProfile(active);
    } else {
      setAddress("");
      setServer(null);
      setPairing(null);
      setState("not-configured");
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!address.trim() || busy) return;

    setState("verifying");
    setServer(null);
    setPairing(null);
    setError(null);

    try {
      const verified = await invoke<VerifiedServer>("verify_server", { address });
      setServer(verified);
      setAddress(verified.address);
      setState("verified");
    } catch (reason) {
      setError(errorMessage(reason));
      setState("not-configured");
    }
  }

  async function requestPairing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!server || !deviceName.trim() || busy) return;

    setState("requesting");
    setError(null);
    setPairing(null);
    try {
      const session = await invoke<PairingSession>("start_pairing", {
        address: server.address,
        serverId: server.serverId,
        deviceName,
      });
      setPairing(session);
      setPollAttempt(0);
      setState("pairing");
    } catch (reason) {
      setError(errorMessage(reason));
      setState("verified");
    }
  }

  function beginAddServer() {
    setAddress("");
    setServer(null);
    setPairing(null);
    setError(null);
    setState("not-configured");
  }

  async function cancelSetup() {
    if (pairing && server) {
      try {
        await invoke("cancel_pairing", { serverId: server.serverId });
      } catch (reason) {
        setError(errorMessage(reason));
        return;
      }
    }
    const active = profiles.find((profile) => profile.serverId === activeServerId);
    if (active) showProfile(active);
  }

  async function cancelPairingRequest() {
    if (!server || profileBusy) return;
    setProfileBusy(true);
    try {
      await invoke("cancel_pairing", { serverId: server.serverId });
      setPairing(null);
      setError(null);
      setState("verified");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setProfileBusy(false);
    }
  }

  async function switchProfile(serverId: string) {
    if (serverId === activeServerId || busy || state === "pairing") return;
    setProfileBusy(true);
    setError(null);
    clearConnectionHealth();
    try {
      const profile = await invoke<ConnectionProfile>("activate_profile", {
        serverId,
      });
      setActiveServerId(profile.serverId);
      showProfile(profile);
    } catch (reason) {
      setHeartbeatError(errorMessage(reason));
    } finally {
      setProfileBusy(false);
    }
  }

  async function reconnectNow() {
    if (reconnecting) return;
    setReconnecting(true);
    setHeartbeatError(null);
    try {
      await invoke("request_heartbeat");
    } catch (reason) {
      setHeartbeatError(errorMessage(reason));
    } finally {
      setReconnecting(false);
    }
  }

  async function handleOffer(
    offer: ShareOfferSummary,
    action: "open" | "copy" | "save" | "decline",
  ) {
    if (offerBusy) return;
    setOfferBusy(offer.id);
    setOfferError(null);
    try {
      const remaining = await invoke<ShareOfferSummary[]>("resolve_share_offer", {
        eventId: offer.id,
        action,
      });
      setOffers(remaining);
      setTransferHistory((current) => [
        { ...offer, action, resolvedAt: new Date().toISOString() },
        ...current.filter((item) => item.id !== offer.id),
      ].slice(0, 50));
    } catch (reason) {
      setOfferError(errorMessage(reason));
    } finally {
      setOfferBusy(null);
    }
  }

  async function handleBatch(batch: ShareBatch, action: "accept" | "reject" | "resume") {
    if (batchBusy) return;
    setBatchBusy(batch.id);
    setBatchError(null);
    try {
      await invoke(action === "accept" ? "accept_share_batch" : action === "reject" ? "reject_share_batch" : "resume_received_batch", { batchId: batch.id });
      setShareBatches(await invoke<ShareBatch[]>("list_share_batches"));
    } catch (reason) {
      setBatchError(errorMessage(reason));
    } finally {
      setBatchBusy(null);
    }
  }

  async function resumeLocalBatch(item: LocalBatchSummary) {
    if (batchBusy) return;
    setBatchBusy(item.requestKey);
    setBatchError(null);
    try {
      await invoke("resume_share_batch", { requestKey: item.requestKey });
      setLocalBatches(await invoke<LocalBatchSummary[]>("list_local_share_batches"));
    } catch (reason) {
      setBatchError(errorMessage(reason));
    } finally {
      setBatchBusy(null);
    }
  }

  async function disconnect(revoke: boolean) {
    const message = revoke
      ? "Disconnect this computer and revoke its credential on the active HomePlace server? Other paired servers will remain available."
      : "Forget the active server locally? This device will remain listed there until it is revoked in HomePlace.";
    if (platform.platform === "macos") {
      try {
        await invoke("authenticate_sensitive_action", { reason: message });
      } catch (reason) {
        setHeartbeatError(errorMessage(reason));
        return;
      }
    } else if (!window.confirm(message)) return;

    setProfileBusy(true);
    try {
      await invoke("disconnect_device", { revoke });
      clearConnectionHealth();
      setStartupError(null);
      setError(null);
      await reloadProfiles();
    } catch (reason) {
      setHeartbeatError(errorMessage(reason));
    } finally {
      setProfileBusy(false);
    }
  }

  async function updateStartup(enabled: boolean) {
    if (startupBusy) return;
    setStartupBusy(true);
    setStartupError(null);
    try {
      const status = await invoke<StartupStatus>("set_startup_enabled", {
        enabled,
      });
      setStartupEnabled(status.enabled);
    } catch (reason) {
      setStartupError(errorMessage(reason));
    } finally {
      setStartupBusy(false);
    }
  }

  async function updateClipboardSync(enabled: boolean) {
    if (clipboardSyncBusy) return;
    setClipboardSyncBusy(true);
    setClipboardSyncError(null);
    try {
      const status = await invoke<ClipboardSyncStatus>("set_clipboard_sync", { enabled });
      setClipboardSyncEnabled(status.enabled);
    } catch (reason) {
      setClipboardSyncError(errorMessage(reason));
    } finally {
      setClipboardSyncBusy(false);
    }
  }

  async function updateSystemNotifications(enabled: boolean) {
    if (systemNotificationsBusy) return;
    setSystemNotificationsBusy(true);
    setSystemNotificationsError(null);
    try {
      const status = await invoke<SystemNotificationStatus>("set_system_notifications", { enabled });
      setSystemNotificationsEnabled(status.enabled);
    } catch (reason) {
      setSystemNotificationsError(errorMessage(reason));
    } finally {
      setSystemNotificationsBusy(false);
    }
  }

  async function submitReminder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reminderTitle.trim() || !reminderAt || reminderBusy) return;
    setReminderBusy(true);
    setReminderError(null);
    try {
      const items = await invoke<Reminder[]>(editingReminderId ? "update_reminder" : "create_reminder", {
        ...(editingReminderId ? { id: editingReminderId } : {}),
        title: reminderTitle,
        at: new Date(reminderAt).toISOString(),
        repeat: reminderRepeat,
      });
      setReminders(items);
      setReminderTitle("");
      setReminderAt(defaultReminderTime());
      setReminderRepeat("none");
      setEditingReminderId(null);
      setAddingReminder(false);
    } catch (reason) {
      setReminderError(errorMessage(reason));
    } finally {
      setReminderBusy(false);
    }
  }

  function editReminder(reminder: Reminder) {
    setEditingReminderId(reminder.id);
    setReminderTitle(reminder.title);
    setReminderAt(localDateTimeInput(new Date(reminder.at)));
    setReminderRepeat(reminder.repeat);
    setAddingReminder(true);
  }

  function closeReminderForm() {
    setAddingReminder(false);
    setEditingReminderId(null);
    setReminderTitle("");
    setReminderAt(defaultReminderTime());
    setReminderRepeat("none");
  }

  function createCalendarEventForSelectedDay() {
    const start = new Date(`${selectedCalendarDay}T09:00:00`);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    setEditingCalendarEventId(null);
    setCalendarTitle("");
    setCalendarStart(localDateTimeInput(start));
    setCalendarEnd(localDateTimeInput(end));
    setCalendarAllDay(false);
    setCalendarLocation("");
    setCalendarError(null);
    setShowCalendarForm(true);
  }

  function moveCalendarMonth(delta: number) {
    setCalendarLoaded(false);
    setCalendarError(null);
    setCalendarMonthOffset((value) => value + delta);
  }

  function showCurrentCalendarMonth() {
    setCalendarLoaded(false);
    setCalendarError(null);
    setCalendarMonthOffset(0);
    setSelectedCalendarDay(localDayKey(new Date()));
  }

  function editCalendarEvent(event: CalendarEvent) {
    setEditingCalendarEventId(event.id);
    setCalendarTitle(event.summary);
    setCalendarStart(event.allDay ? event.start : localDateTimeInput(new Date(event.start)));
    setCalendarEnd(event.allDay ? event.end : localDateTimeInput(new Date(event.end)));
    setCalendarAllDay(event.allDay);
    setCalendarLocation(event.location ?? "");
    setCalendarError(null);
    setShowCalendarForm(true);
  }

  function changeCalendarAllDay(enabled: boolean) {
    const day = calendarStart.slice(0, 10) || selectedCalendarDay;
    setCalendarAllDay(enabled);
    if (enabled) {
      const next = new Date(`${day}T12:00:00`);
      next.setDate(next.getDate() + 1);
      setCalendarStart(day);
      setCalendarEnd(localDayKey(next));
    } else {
      setCalendarStart(`${day}T09:00`);
      setCalendarEnd(`${day}T10:00`);
    }
  }

  async function submitCalendarEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!calendarTitle.trim() || !calendarStart || !calendarEnd || calendarBusy) return;
    setCalendarBusy(true);
    setCalendarError(null);
    try {
      const input = {
        ...visibleCalendarRange(calendarMonthOffset),
        summary: calendarTitle,
        start: calendarAllDay ? calendarStart : new Date(calendarStart).toISOString(),
        end: calendarAllDay ? calendarEnd : new Date(calendarEnd).toISOString(),
        allDay: calendarAllDay,
        location: calendarLocation || null,
      };
      const result = await invoke<CalendarSummary>(editingCalendarEventId ? "update_calendar_event" : "create_calendar_event", {
        ...(editingCalendarEventId ? { id: editingCalendarEventId } : {}),
        input,
      });
      setCalendarEvents(result.events);
      setCalendarStatus(result.status);
      setShowCalendarForm(false);
      setEditingCalendarEventId(null);
    } catch (reason) {
      setCalendarError(errorMessage(reason));
    } finally {
      setCalendarBusy(false);
    }
  }

  async function removeCalendarEvent(id: string) {
    if (calendarBusy || !window.confirm(ui.productivity.deleteEventConfirm)) return;
    setCalendarBusy(true);
    setCalendarError(null);
    try {
      const result = await invoke<CalendarSummary>("delete_calendar_event", { id, ...visibleCalendarRange(calendarMonthOffset) });
      setCalendarEvents(result.events);
      setCalendarStatus(result.status);
    } catch (reason) {
      setCalendarError(errorMessage(reason));
    } finally {
      setCalendarBusy(false);
    }
  }

  async function duplicateCalendarEvent(event: CalendarEvent) {
    if (calendarBusy) return;
    setCalendarBusy(true);
    setCalendarError(null);
    try {
      const suffix = language === "ru" ? " — копия" : " — copy";
      const result = await invoke<CalendarSummary>("create_calendar_event", {
        input: {
          ...visibleCalendarRange(calendarMonthOffset),
          summary: `${event.summary.slice(0, 300 - suffix.length)}${suffix}`,
          start: event.start,
          end: event.end,
          allDay: event.allDay,
          location: event.location ?? null,
        },
      });
      setCalendarEvents(result.events);
      setCalendarStatus(result.status);
    } catch (reason) {
      setCalendarError(errorMessage(reason));
    } finally {
      setCalendarBusy(false);
    }
  }

  async function moveCalendarEventToTomorrow(event: CalendarEvent) {
    if (calendarBusy) return;
    setCalendarBusy(true);
    setCalendarError(null);
    try {
      const originalStart = new Date(event.allDay ? `${event.start.slice(0, 10)}T12:00:00` : event.start);
      const originalEnd = new Date(event.allDay ? `${event.end.slice(0, 10)}T12:00:00` : event.end);
      const nextStart = new Date();
      nextStart.setDate(nextStart.getDate() + 1);
      nextStart.setHours(originalStart.getHours(), originalStart.getMinutes(), originalStart.getSeconds(), 0);
      const nextEnd = new Date(nextStart.getTime() + (originalEnd.getTime() - originalStart.getTime()));
      const result = await invoke<CalendarSummary>("update_calendar_event", {
        id: event.id,
        input: {
          ...visibleCalendarRange(calendarMonthOffset),
          summary: event.summary,
          start: event.allDay ? localDayKey(nextStart) : nextStart.toISOString(),
          end: event.allDay ? localDayKey(nextEnd) : nextEnd.toISOString(),
          allDay: event.allDay,
          location: event.location ?? null,
        },
      });
      setCalendarEvents(result.events);
      setCalendarStatus(result.status);
    } catch (reason) {
      setCalendarError(errorMessage(reason));
    } finally {
      setCalendarBusy(false);
    }
  }

  async function resolveReminder(action: "complete_reminder" | "delete_reminder", id: string) {
    if (reminderBusy) return;
    setReminderBusy(true);
    setReminderError(null);
    try {
      const items = await invoke<Reminder[]>(action, { id });
      setReminders(items);
      setCompletedReminders(await invoke<CompletedReminder[]>("list_completed_reminders"));
    } catch (reason) {
      setReminderError(errorMessage(reason));
    } finally {
      setReminderBusy(false);
    }
  }

  async function restoreCompletedReminder(id: string) {
    if (reminderBusy) return;
    setReminderBusy(true);
    setReminderError(null);
    try {
      const items = await invoke<Reminder[]>("restore_reminder", { id });
      setReminders(items);
      setCompletedReminders(await invoke<CompletedReminder[]>("list_completed_reminders"));
    } catch (reason) {
      setReminderError(errorMessage(reason));
    } finally {
      setReminderBusy(false);
    }
  }

  async function clearCompletedReminderHistory() {
    if (reminderBusy || completedReminders.length === 0) return;
    if (!window.confirm(language === "ru" ? "Удалить все выполненные напоминания?" : "Delete all completed reminders?")) return;
    setReminderBusy(true);
    setReminderError(null);
    try {
      const items = await invoke<Reminder[]>("clear_completed_reminders");
      setReminders(items);
      setCompletedReminders([]);
    } catch (reason) {
      setReminderError(errorMessage(reason));
    } finally {
      setReminderBusy(false);
    }
  }

  async function rescheduleReminder(reminder: Reminder, at: Date) {
    if (reminderBusy) return;
    setReminderBusy(true);
    setReminderError(null);
    try {
      const items = await invoke<Reminder[]>("update_reminder", {
        id: reminder.id,
        title: reminder.title,
        at: at.toISOString(),
        repeat: reminder.repeat,
      });
      setReminders(items);
    } catch (reason) {
      setReminderError(errorMessage(reason));
    } finally {
      setReminderBusy(false);
    }
  }

  function snoozeReminder(reminder: Reminder, minutes: number) {
    const next = new Date(Math.max(today.getTime(), new Date(reminder.at).getTime()) + minutes * 60_000);
    void rescheduleReminder(reminder, next);
  }

  function moveReminderToTomorrow(reminder: Reminder) {
    const current = new Date(reminder.at);
    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(current.getHours(), current.getMinutes(), 0, 0);
    void rescheduleReminder(reminder, next);
  }

  function moveReminderToBucket(reminder: Reminder, bucket: ReminderBucket) {
    const current = new Date(reminder.at);
    const next = new Date();
    if (bucket === "overdue") {
      next.setDate(next.getDate() - 1);
      next.setHours(current.getHours(), current.getMinutes(), 0, 0);
    } else if (bucket === "today") {
      const soon = new Date(today.getTime() + 5 * 60_000);
      next.setHours(
        Math.max(current.getHours(), soon.getHours()),
        current.getHours() > soon.getHours() ? current.getMinutes() : soon.getMinutes(),
        0,
        0,
      );
    } else {
      next.setDate(next.getDate() + 1);
      next.setHours(current.getHours(), current.getMinutes(), 0, 0);
    }
    void rescheduleReminder(reminder, next);
  }

  function dropReminder(bucket: ReminderBucket) {
    const reminder = reminders.find((item) => item.id === draggedReminderId);
    setDraggedReminderId(null);
    setReminderDropTarget(null);
    if (reminder) moveReminderToBucket(reminder, bucket);
  }

  function toggleReminderExpanded(id: string) {
    setExpandedReminderIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function duplicateReminder(reminder: Reminder) {
    if (reminderBusy) return;
    setReminderBusy(true);
    setReminderError(null);
    try {
      const suffix = language === "ru" ? " — копия" : " — copy";
      const title = `${reminder.title.slice(0, 200 - suffix.length)}${suffix}`;
      const items = await invoke<Reminder[]>("create_reminder", {
        title,
        at: reminder.at,
        repeat: reminder.repeat,
      });
      setReminders(items);
    } catch (reason) {
      setReminderError(errorMessage(reason));
    } finally {
      setReminderBusy(false);
    }
  }

  function reminderRepeatLabel(repeat: string) {
    const labels: Record<string, [string, string]> = {
      hourly: ["Каждый час", "Hourly"],
      daily: ["Каждый день", "Daily"],
      weekly: ["Каждую неделю", "Weekly"],
      monthly: ["Каждый месяц", "Monthly"],
      yearly: ["Каждый год", "Yearly"],
    };
    const label = labels[repeat];
    if (label) return label[language === "ru" ? 0 : 1];
    const custom = /^every:(\d+):(hour|day|week|month|year)$/.exec(repeat);
    if (!custom) return repeat;
    const count = Number(custom[1]);
    const units = language === "ru"
      ? { hour: "ч.", day: "дн.", week: "нед.", month: "мес.", year: "г." }
      : { hour: "hours", day: "days", week: "weeks", month: "months", year: "years" };
    return language === "ru"
      ? `Каждые ${count} ${units[custom[2] as keyof typeof units]}`
      : `Every ${count} ${units[custom[2] as keyof typeof units]}`;
  }

  function reminderContextActions(reminder: Reminder): ContextAction[] {
    return [
      { label: expandedReminderIds.has(reminder.id) ? contextLabels.collapse : contextLabels.expand, icon: "open", run: () => toggleReminderExpanded(reminder.id) },
      { label: contextLabels.complete, icon: "check", disabled: reminderBusy, run: () => void resolveReminder("complete_reminder", reminder.id) },
      { label: contextLabels.edit, icon: "edit", disabled: reminderBusy, run: () => editReminder(reminder) },
      { label: contextLabels.snoozeTen, icon: "focus", disabled: reminderBusy, run: () => snoozeReminder(reminder, 10) },
      { label: contextLabels.snoozeHour, icon: "focus", disabled: reminderBusy, run: () => snoozeReminder(reminder, 60) },
      { label: contextLabels.moveToday, icon: "calendar", disabled: reminderBusy, run: () => moveReminderToBucket(reminder, "today") },
      { label: contextLabels.tomorrow, icon: "calendar", disabled: reminderBusy, run: () => moveReminderToTomorrow(reminder) },
      { label: contextLabels.moveUpcoming, icon: "calendar", disabled: reminderBusy, run: () => moveReminderToBucket(reminder, "upcoming") },
      { label: contextLabels.duplicate, icon: "plus", disabled: reminderBusy, run: () => void duplicateReminder(reminder) },
      {
        label: contextLabels.remove,
        icon: "trash",
        danger: true,
        disabled: reminderBusy,
        run: () => {
          if (window.confirm(ui.productivity.deleteReminderConfirm)) void resolveReminder("delete_reminder", reminder.id);
        },
      },
    ];
  }

  function reminderRows(items: Reminder[]) {
    if (!remindersLoaded) {
      return <p className="reminder-empty">{ui.productivity.loading}</p>;
    }
    if (items.length === 0) {
      return <p className="reminder-empty">{ui.productivity.empty}</p>;
    }
    return items.map((reminder) => {
      const at = new Date(reminder.at);
      return (
        <div
          className={`reminder-item${expandedReminderIds.has(reminder.id) ? " expanded" : ""}${draggedReminderId === reminder.id ? " dragging" : ""}`}
          key={reminder.id}
          draggable={!reminderBusy}
          onDragStart={(event) => {
            setDraggedReminderId(reminder.id);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", reminder.id);
          }}
          onDragEnd={() => {
            setDraggedReminderId(null);
            setReminderDropTarget(null);
          }}
          onContextMenu={(event) => openContextMenu(event, reminderContextActions(reminder))}
        >
          <button
            type="button"
            className="reminder-complete"
            aria-label={`${ui.productivity.complete}: ${reminder.title}`}
            title={ui.productivity.complete}
            disabled={reminderBusy}
            onClick={() => void resolveReminder("complete_reminder", reminder.id)}
          />
          <button
            type="button"
            className="reminder-copy"
            aria-expanded={expandedReminderIds.has(reminder.id)}
            title={language === "ru" ? "Открыть напоминание" : "Open reminder"}
            onClick={() => toggleReminderExpanded(reminder.id)}
          >
            <b>{reminder.title}</b>
            <small>
              {at.toLocaleString(language === "ru" ? "ru-RU" : "en-US", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
              {reminder.repeat !== "none" ? ` · ${reminderRepeatLabel(reminder.repeat)}` : ""}
            </small>
          </button>
          <button
            type="button"
            className="reminder-edit"
            aria-label={`${ui.productivity.edit}: ${reminder.title}`}
            title={ui.productivity.edit}
            disabled={reminderBusy}
            onClick={(event) => openContextMenu(event, reminderContextActions(reminder))}
          >
            ···
          </button>
          <button
            type="button"
            className="reminder-delete"
            aria-label={`${ui.productivity.delete}: ${reminder.title}`}
            title={ui.productivity.delete}
            disabled={reminderBusy}
            onClick={() => {
              if (window.confirm(ui.productivity.deleteReminderConfirm)) void resolveReminder("delete_reminder", reminder.id);
            }}
          >
            ×
          </button>
        </div>
      );
    });
  }

  function completedReminderRows() {
    if (!remindersLoaded) return <p className="reminder-empty">{ui.productivity.loading}</p>;
    if (completedReminders.length === 0) {
      return <p className="reminder-empty">{language === "ru" ? "Выполненных пока нет" : "Nothing completed yet"}</p>;
    }
    return completedReminders.map((reminder) => (
      <div
        className={`reminder-item completed${expandedReminderIds.has(reminder.id) ? " expanded" : ""}`}
        key={reminder.id}
        onContextMenu={(event) => openContextMenu(event, [
          { label: expandedReminderIds.has(reminder.id) ? contextLabels.collapse : contextLabels.expand, icon: "open", run: () => toggleReminderExpanded(reminder.id) },
          { label: contextLabels.restore, icon: "refresh", disabled: reminderBusy, run: () => void restoreCompletedReminder(reminder.id) },
          { label: contextLabels.copy, icon: "clipboard", run: () => void navigator.clipboard.writeText(reminder.title) },
          { label: contextLabels.remove, icon: "trash", danger: true, disabled: reminderBusy, run: () => void resolveReminder("delete_reminder", reminder.id) },
        ])}
      >
        <span className="reminder-complete-mark"><Icon name="check" size={10} /></span>
        <button type="button" className="reminder-copy" aria-expanded={expandedReminderIds.has(reminder.id)} onClick={() => toggleReminderExpanded(reminder.id)}>
          <b>{reminder.title}</b>
          <small>{reminder.completedAt
            ? `${language === "ru" ? "Выполнено" : "Completed"} ${new Date(reminder.completedAt).toLocaleString(language === "ru" ? "ru-RU" : "en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
            : (language === "ru" ? "Дата выполнения неизвестна" : "Completion date unavailable")}</small>
        </button>
        <button type="button" className="reminder-restore" disabled={reminderBusy} onClick={() => void restoreCompletedReminder(reminder.id)} title={contextLabels.restore}><Icon name="refresh" size={12} /></button>
      </div>
    ));
  }

  const incomingOffer = offers.find((offer) => offer.id !== dismissedOfferId) ?? null;

  return (
    <main className={`desktop-shell${sidebarExpanded ? " sidebar-expanded" : ""}${sidebarPinned ? " sidebar-pinned" : ""}`}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div
        className="window-drag-region"
        data-tauri-drag-region
        aria-hidden
        onMouseDown={(event) => {
          if (event.button === 0) void invoke("start_window_drag");
        }}
      />

      <aside
        className="app-sidebar"
        aria-label="Main navigation"
        onMouseEnter={() => setSidebarExpanded(true)}
        onMouseLeave={(event) => {
          if (!sidebarPinned && !event.currentTarget.contains(document.activeElement)) setSidebarExpanded(false);
        }}
        onFocus={() => setSidebarExpanded(true)}
        onBlur={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
            if (!sidebarPinned) setSidebarExpanded(false);
          }
        }}
      >
        <div className="sidebar-brand" data-tauri-drag-region>
          <div className="brand-mark" aria-hidden>
            <img src="/branding/homeplace-mark.png" alt="" />
          </div>
          <div>
            <p className="eyebrow">HomePlace</p>
            <strong>Link</strong>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navigation.map((item) => (
            <Fragment key={item.id}>
              {(item.id === "overview" || item.id === "devices" || item.id === "automations") && (
                <span className="sidebar-nav-group-label" aria-hidden="true">
                  {item.id === "overview" ? (language === "ru" ? "Рабочее" : "Workspace") : item.id === "devices" ? (language === "ru" ? "Связь" : "Connected") : (language === "ru" ? "Ещё" : "More")}
                </span>
              )}
            <button
              type="button"
              className={activeSection === item.id ? "active" : undefined}
              aria-current={activeSection === item.id ? "page" : undefined}
              aria-label={ui.nav[item.id]}
              title={ui.nav[item.id]}
              onClick={() => setActiveSection(item.id)}
              onContextMenu={(event) => openContextMenu(event, [
                { label: contextLabels.open, icon: item.icon, run: () => setActiveSection(item.id) },
                { label: contextLabels.quickShare, icon: "transfer", disabled: !activeServerId, run: () => openQuickShare() },
                { label: contextLabels.reconnect, icon: "refresh", disabled: !activeServerId || reconnecting, run: () => void reconnectNow() },
              ])}
            >
              <Icon name={item.icon} size={22} className="nav-icon" />
              <span className="nav-label">{ui.nav[item.id]}</span>
              {item.id === "notifications" && notificationFailures > 0 && (
                <small>{notificationFailures}</small>
              )}
            </button>
            </Fragment>
          ))}
        </nav>

        <button
          type="button"
          className="sidebar-pin"
          aria-pressed={sidebarPinned}
          aria-label={sidebarPinned ? (language === "ru" ? "Открепить боковое меню" : "Unpin sidebar") : (language === "ru" ? "Закрепить боковое меню" : "Pin sidebar")}
          title={sidebarPinned ? (language === "ru" ? "Открепить меню" : "Unpin sidebar") : (language === "ru" ? "Закрепить меню" : "Pin sidebar")}
          onClick={() => {
            const next = !sidebarPinned;
            setSidebarPinned(next);
            setSidebarExpanded(true);
            window.localStorage.setItem("homeplace-sidebar-pinned", next ? "1" : "0");
          }}
        ><Icon name="pin" size={18} /><span>{sidebarPinned ? (language === "ru" ? "Меню закреплено" : "Sidebar pinned") : (language === "ru" ? "Закрепить меню" : "Pin sidebar")}</span></button>

        <div className="sidebar-status">
          <span className={lastHeartbeat ? "online" : undefined} aria-hidden />
          <div>
            <b>{server?.serverName ?? ui.noServer}</b>
            <small>{lastHeartbeat ? ui.connected : ui.waiting}</small>
          </div>
        </div>
      </aside>

      <div className="app-content">

      <header className="titlebar" data-tauri-drag-region>
        <div className="titlebar-heading">
          <span className="titlebar-section-icon" aria-hidden>
            <Icon name={navigation.find((item) => item.id === activeSection)?.icon ?? "home"} size={21} />
          </span>
          <div>
            <h1>{ui.nav[activeSection]}</h1>
            <p className="titlebar-subtitle">
              {activeSection === "overview" && (lastHeartbeat
                ? `${server?.serverName ?? "HomePlace"} · ${language === "ru" ? "подключено" : "connected"}`
                : (language === "ru" ? "Ожидание подключения" : "Waiting for connection"))}
              {activeSection === "devices" && (!activeServerId
                ? (language === "ru" ? "HomePlace не подключён" : "HomePlace is not connected")
                : !accountDevicesLoaded
                  ? (language === "ru" ? "Загружаем устройства…" : "Loading devices…")
                  : accountDevicesError
                    ? (language === "ru" ? "Устройства временно недоступны" : "Devices are temporarily unavailable")
                    : `${deviceCountLabel(accountDevices.length, language)} · ${accountDevices.filter((item) => item.online).length} ${language === "ru" ? "в сети" : "online"}`)}
              {activeSection === "clipboard" && (clipboardSyncEnabled
                ? (language === "ru" ? "Синхронизация включена" : "Sync is on")
                : (language === "ru" ? "Синхронизация выключена" : "Sync is off"))}
              {activeSection === "transfers" && (language === "ru"
                ? `${offers.length} входящих · ${transferHistory.length} в истории`
                : `${offers.length} incoming · ${transferHistory.length} in history`)}
              {activeSection === "automations" && (language === "ru" ? "Пока недоступны в Desktop" : "Not available in Desktop yet")}
              {activeSection === "productivity" && (language === "ru"
                ? (activeServerId ? `${reminders.length} напоминаний · ${calendarEvents.length} событий` : "Календарь, напоминания и идеи")
                : (activeServerId ? `${reminders.length} reminders · ${calendarEvents.length} events` : "Calendar, reminders and ideas"))}
              {activeSection === "media" && (language === "ru" ? "Поиск, запросы и очередь загрузок" : "Search, requests and download queue")}
              {activeSection === "monitoring" && (language === "ru" ? "Контейнеры, сервисы и события" : "Containers, services and events")}
              {activeSection === "notifications" && (notificationFailures > 0
                ? (language === "ru" ? `${notificationFailures} требуют внимания` : `${notificationFailures} need attention`)
                : (language === "ru" ? "Ошибок доставки нет" : "No delivery issues"))}
              {activeSection === "settings" && (activeServerId
                ? `${server?.serverName ?? "HomePlace"} · ${lastHeartbeat ? (language === "ru" ? "в сети" : "online") : (language === "ru" ? "не в сети" : "offline")}`
                : (language === "ru" ? "Нет активного подключения" : "No active connection"))}
            </p>
          </div>
        </div>
        <div className="titlebar-actions">
          {activeSection === "devices" && (
            <button
              type="button"
              className="titlebar-context-action"
              onClick={() => setActiveSection("settings")}
            >
              <Icon name="settings" size={15} />
              <span>{language === "ru" ? "Подключения" : "Connections"}</span>
            </button>
          )}
          {activeSection === "clipboard" && (
            <button
              type="button"
              className={`titlebar-context-action${clipboardSyncEnabled ? " active" : ""}`}
              disabled={!clipboardSyncLoaded || clipboardSyncBusy || !activeServerId}
              onClick={() => void updateClipboardSync(!clipboardSyncEnabled)}
            >
              <Icon name="clipboard" size={15} />
              <span>{clipboardSyncEnabled ? ui.clipboard.on : ui.clipboard.off}</span>
            </button>
          )}
          <button
            type="button"
            className="theme-toggle"
            aria-label={language === "ru" ? "Сменить тему" : "Change theme"}
            title={language === "ru" ? "Сменить тему" : "Change theme"}
            onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
          </button>
          <div className="language-switcher" aria-label={ui.language}>
            <button type="button" className={language === "ru" ? "active" : undefined} onClick={() => setLanguage("ru")}>RU</button>
            <button type="button" className={language === "en" ? "active" : undefined} onClick={() => setLanguage("en")}>EN</button>
          </div>
          <span className="platform-pill">{platform.label}</span>
        </div>
      </header>

      {activeSection === "devices" && (
        <section className="section-stack account-devices-page" aria-label={ui.nav.devices}>
          {!activeServerId ? (
            <div className="glass-card empty-state"><span><Icon name="link" size={20} /></span><b>{language === "ru" ? "Сначала подключите HomePlace" : "Connect HomePlace first"}</b><p>{language === "ru" ? "Управление подключением находится в настройках." : "Connection management is available in Settings."}</p></div>
          ) : !accountDevicesLoaded ? (
            <div className="glass-card empty-state"><span><Icon name="refresh" size={20} /></span><b>{language === "ru" ? "Загружаем устройства…" : "Loading devices…"}</b></div>
          ) : accountDevicesError ? (
            <div className="glass-card empty-state"><span>!</span><b>{language === "ru" ? "Не удалось получить устройства" : "Could not load devices"}</b><p>{accountDevicesError}</p></div>
          ) : accountDevices.length === 0 ? (
            <div className="glass-card empty-state"><span><Icon name="devices" size={20} /></span><b>{language === "ru" ? "Устройств пока нет" : "No devices yet"}</b><p>{language === "ru" ? "Добавьте устройство через настройки подключения." : "Add a device from connection settings."}</p></div>
          ) : (
            <div className="account-device-grid">
              {accountDevices.map((item) => (
                <article
                  className={`glass-card account-device-card${item.online ? " online" : ""}`}
                  key={item.id}
                  onContextMenu={(event) => openContextMenu(event, [
                    { label: contextLabels.quickShare, icon: "transfer", disabled: item.currentDevice, run: () => openQuickShare() },
                    { label: contextLabels.copy, icon: "clipboard", run: () => void navigator.clipboard.writeText(item.name) },
                    ...(item.currentDevice ? [{ label: contextLabels.reconnect, icon: "refresh" as IconName, disabled: reconnecting, run: () => void reconnectNow() }] : []),
                  ])}
                >
                  <span className="account-device-icon"><Icon name={accountDeviceIcon(item.platform)} size={31} /></span>
                  <div className="account-device-copy">
                    <div><h3>{item.name}</h3>{item.currentDevice && <em>{language === "ru" ? "Это устройство" : "This device"}</em>}</div>
                    <p>{item.ownerName} · {item.platform} {item.platformVersion}</p>
                    <small>{item.online ? (language === "ru" ? "Сейчас в сети" : "Online now") : item.lastSeenAt ? `${language === "ru" ? "Было в сети" : "Last seen"} ${new Date(item.lastSeenAt).toLocaleString(language === "ru" ? "ru-RU" : "en-US")}` : (language === "ru" ? "Ещё не выходило в сеть" : "Never connected")}</small>
                  </div>
                  <span className={`account-device-state${item.online ? " online" : ""}`} aria-label={item.online ? "online" : "offline"} />
                  {!item.currentDevice && <button type="button" className="device-share-action" onClick={() => openQuickShare()} aria-label={language === "ru" ? `Отправить на ${item.name}` : `Send to ${item.name}`}><Icon name="transfer" size={18} /></button>}
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {activeSection === "settings" && (
      <section className="glass-card hero-card">
        {(!activeServerId || isAddingServer) && <div className="hero-copy">
          <p className="eyebrow">
            <span className="status-dot" aria-hidden />
            {ui.devices.private}
          </p>
          <h2>{ui.devices.connect} {platform.label} {ui.devices.toHomePlace}</h2>
          <p className="lead">
            {ui.devices.lead} {platform.secureStorage}.
          </p>
        </div>}

        {profiles.length > 0 && (
          <section className="profile-switcher" aria-label="Paired servers">
            <div className="profile-heading">
              <div>
                  <p className="eyebrow">{ui.devices.paired}</p>
                  <strong>{profiles.length} {ui.devices.available}</strong>
              </div>
              {isAddingServer ? (
                <button type="button" onClick={() => void cancelSetup()}>
                  {ui.devices.cancelSetup}
                </button>
              ) : (
                <button type="button" onClick={beginAddServer} disabled={busy}>
                  {ui.devices.addServer}
                </button>
              )}
            </div>
            <div className="profile-list">
              {profiles.map((profile) => (
                <button
                  type="button"
                  className={
                    profile.serverId === activeServerId ? "active" : undefined
                  }
                  aria-pressed={profile.serverId === activeServerId}
                  disabled={busy || state === "pairing"}
                  onClick={() => void switchProfile(profile.serverId)}
                  onContextMenu={(event) => openContextMenu(event, [
                    { label: contextLabels.open, icon: "devices", disabled: profile.serverId === activeServerId, run: () => void switchProfile(profile.serverId) },
                    { label: contextLabels.copyAddress, icon: "link", run: () => void navigator.clipboard.writeText(profile.address) },
                    { label: contextLabels.quickShare, icon: "transfer", disabled: profile.serverId !== activeServerId, run: () => openQuickShare() },
                    { label: contextLabels.reconnect, icon: "refresh", disabled: profile.serverId !== activeServerId || reconnecting, run: () => void reconnectNow() },
                  ])}
                  title={profile.address}
                  key={profile.serverId}
                >
                  <span>{profile.serverName.slice(0, 1).toUpperCase()}</span>
                  <span>
                    <b>{profile.serverName}</b>
                    <small>{profile.deviceName}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <ol className="progress" aria-label="Connection progress">
        {ui.devices.steps.map((step, index) => (
            <li className={index <= current ? "active" : ""} key={step}>
              <span>{index + 1}</span>
              {step}
            </li>
          ))}
        </ol>

        {!profilesLoaded && (
          <p className="loading-profile" aria-live="polite">
            {ui.devices.loading}
          </p>
        )}

        {profilesLoaded && state !== "connected" && (
          <form className="connect-form" onSubmit={verify}>
            <label htmlFor="server-address">{ui.devices.server}</label>
            <div className="field-row">
              <input
                id="server-address"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="https://home.example.net or http://192.168.1.20:3200"
                aria-describedby="address-hint connection-message"
                aria-invalid={Boolean(error)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy || state === "pairing"}
                required
              />
              <button
                type="submit"
                disabled={!address.trim() || busy || state === "pairing"}
              >
                {state === "verifying" ? ui.devices.verifying : ui.devices.verify}
              </button>
            </div>
            <p className="hint" id="address-hint">
              {ui.devices.addressHint}
            </p>
          </form>
        )}

        <div id="connection-message" aria-live="polite">
          {error && <div className="connection-message error" role="alert">{error}</div>}
          {server && state !== "not-configured" && state !== "connected" && (
            <div className="connection-message">
              <div>
                <strong>{server.serverName}</strong>
                  <span>{ui.devices.compatible}</span>
              </div>
              {server.reducedSecurity && (
                  <span className="security-badge">{ui.devices.localHttp}</span>
              )}
            </div>
          )}
        </div>

        {server && state === "verified" && (
          <form className="pairing-form" onSubmit={requestPairing}>
              <label htmlFor="device-name">{ui.devices.deviceName}</label>
            <div className="field-row">
              <input
                id="device-name"
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                maxLength={80}
                disabled={busy}
                required
              />
              <button type="submit" disabled={!deviceName.trim() || busy}>
                {ui.devices.request}
              </button>
            </div>
            <p className="hint">{ui.devices.keyHint}</p>
          </form>
        )}

        {pairing && state === "pairing" && (
          <section className="approval-card" aria-label="Pairing approval">
            <p className="eyebrow">{ui.devices.confirm}</p>
            <strong className="pairing-code">{pairing.code}</strong>
            <p>
              {ui.devices.openDevices} {deviceName}.
            </p>
            <span>
              {ui.devices.waitingSecurely} · {ui.devices.expires}{" "}
              {new Date(pairing.expiresAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            <button
              className="secondary-action"
              type="button"
              disabled={profileBusy}
              onClick={() => void cancelPairingRequest()}
            >
              {ui.devices.cancelRequest}
            </button>
          </section>
        )}

        {state === "connected" && (
        <section className="approval-card connected-card" aria-label={ui.devices.connected}>
          <p className="eyebrow">{ui.devices.connected}</p>
            <strong>
            {deviceName} {ui.devices.pairedWith} {server?.serverName}.
            </strong>
            <p className="server-address">{server?.address}</p>
            {profiles.some((profile) => profile.serverId === activeServerId && !profile.fileBatchApproved) && (
              <div className="connection-message">
                <p>{language === "ru" ? "Приём пакетов файлов требует повторного подтверждения подключения в HomePlace." : "Receiving file batches requires approving this connection again in HomePlace."}</p>
                <button type="button" disabled={busy} onClick={() => { setError(null); setState("verified"); }}>{language === "ru" ? "Подтвердить новые возможности" : "Approve new capabilities"}</button>
              </div>
            )}
            <p>
            {ui.devices.credential} {platform.secureStorage}. {ui.devices.background}
            </p>
            {heartbeatError ? (
              <span className="heartbeat-error">{heartbeatError}</span>
            ) : (
              <span>
                {lastHeartbeat
                  ? `${ui.devices.checked} ${lastHeartbeat.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`
                  : ui.devices.connecting}
                {deliveredNotifications > 0
                ? ` · ${deliveredNotifications} ${ui.devices.delivered}`
                  : ""}
                {notificationFailures > 0
                ? ` · ${notificationFailures} ${ui.devices.attention}`
                  : ""}
                {pendingEvents > 0
                ? ` · ${pendingEvents} ${ui.devices.pending}`
                  : ""}
              </span>
            )}

            {offers.length > 0 && (
              <section className="pending-offers" aria-label="Pending shares">
                <div className="offer-heading">
              <b>{ui.devices.waitingApproval}</b>
                  <span>{offers.length}</span>
                </div>
                {offers.map((offer) => (
                  <article
                    key={offer.id}
                    className="offer-row"
                    onContextMenu={(event) => openContextMenu(event, [
                      {
                        label: contextLabels.accept,
                        icon: "check",
                        disabled: offerBusy !== null,
                        run: () => void handleOffer(offer, offer.kind === "url" ? "open" : offer.kind === "file" ? "save" : "copy"),
                      },
                      { label: contextLabels.decline, icon: "trash", danger: true, disabled: offerBusy !== null, run: () => void handleOffer(offer, "decline") },
                    ])}
                  >
                    <span className="offer-icon" aria-hidden>
                      {offer.kind === "url" ? "↗" : offer.kind === "file" ? "↓" : "T"}
                    </span>
                    <span className="offer-copy">
                      <b>
                    {offer.kind === "url"
                      ? ui.devices.open
                      : offer.kind === "file"
                        ? ui.devices.save
                        : ui.devices.copy}
                      </b>
                      <small>
                    {ui.devices.from} {offer.sourceName} ·{" "}
                        {new Date(offer.sentAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </small>
                    </span>
                    <button
                      type="button"
                      disabled={offerBusy !== null}
                      onClick={() =>
                        void handleOffer(
                          offer,
                          offer.kind === "url"
                            ? "open"
                            : offer.kind === "file"
                              ? "save"
                              : "copy",
                        )
                      }
                    >
                  {offerBusy === offer.id ? ui.devices.working : ui.devices.accept}
                    </button>
                    <button
                      type="button"
                      disabled={offerBusy !== null}
                      onClick={() => void handleOffer(offer, "decline")}
                    >
                  {ui.devices.decline}
                    </button>
                  </article>
                ))}
                {offerError && (
                  <span className="setting-error" role="alert">
                    {offerError}
                  </span>
                )}
              </section>
            )}

            <div className="connection-actions">
              <button
                type="button"
                onClick={() => void reconnectNow()}
                disabled={reconnecting || profileBusy}
              >
            {reconnecting ? ui.devices.reconnecting : ui.devices.reconnect}
              </button>
              <button
                type="button"
                onClick={() => void disconnect(false)}
                disabled={profileBusy}
              >
            {ui.devices.forget}
              </button>
              <button
                type="button"
                onClick={() => void disconnect(true)}
                disabled={profileBusy}
              >
            {ui.devices.disconnect}
              </button>
            </div>

          </section>
        )}
      </section>
      )}

      {activeSection === "overview" && (
        <section className="section-stack" aria-label="Overview">
          {!activeServerId ? (
            <article className="overview-start">
              <span className="overview-start-mark"><Icon name="link" size={28} /></span>
              <p className="eyebrow">HOMEPLACE LINK</p>
              <h2>{language === "ru" ? "Ваши устройства — в одном месте" : "Your devices, in one place"}</h2>
              <p>{language === "ru" ? "Подключите свой сервер HomePlace, чтобы видеть устройства, передачи, медиа и состояние сервисов." : "Connect your HomePlace server to see devices, transfers, media and service health."}</p>
              <button type="button" className="primary-action" onClick={() => setActiveSection("settings")}>{language === "ru" ? "Подключить сервер" : "Connect a server"}<Icon name="link" size={17} /></button>
            </article>
          ) : <>
          <section className="metric-grid" aria-label="Connection summary">
            <button type="button" className="glass-card metric-card" onClick={() => setActiveSection("settings")}>
              <span><Icon name="devices" size={21} /></span>
              <strong>{profiles.length}</strong>
              <small>{ui.overview.paired}</small>
            </button>
            <button type="button" className="glass-card metric-card" onClick={() => setActiveSection("transfers")}>
              <span><Icon name="transfer" size={21} /></span>
              <strong>{pendingEvents}</strong>
              <small>{ui.overview.pending}</small>
            </button>
            <button type="button" className="glass-card metric-card" onClick={() => setActiveSection("notifications")}>
              <span><Icon name="bell" size={21} /></span>
              <strong>{deliveredNotifications}</strong>
              <small>{ui.overview.delivered}</small>
            </button>
          </section>

          <section className="quick-actions" aria-label="Quick actions">
            <button type="button" onClick={() => setActiveSection("clipboard")}>
              <span><Icon name="clipboard" size={18} /></span><b>{ui.overview.clipboard}</b><small>{ui.overview.sync}</small>
            </button>
            <button type="button" onClick={() => setActiveSection("transfers")}>
              <span><Icon name="transfer" size={18} /></span><b>{ui.overview.send}</b><small>{ui.overview.transfer}</small>
            </button>
            <button type="button" onClick={() => setActiveSection("monitoring")}>
              <span><Icon name="monitoring" size={18} /></span><b>{ui.nav.monitoring}</b><small>{language === "ru" ? "Состояние сервера" : "Server health"}</small>
            </button>
          </section>
          <HomeOverview key={activeServerId} serverId={activeServerId} language={language} onNavigate={setActiveSection} requestedPlantId={requestedPlantId} onPlantRequestHandled={() => setRequestedPlantId(null)} />
          </>}
        </section>
      )}

      {activeSection === "clipboard" && (
        <section className="section-stack" aria-label="Clipboard">
          {clipboardSyncError && <p className="setting-error">{clipboardSyncError}</p>}
          <article className="glass-card transfer-list clipboard-history">
            <div className="section-heading">
              <div><p className="eyebrow">{ui.clipboard.eyebrow}</p><h3>{language === "ru" ? "История буфера" : "Clipboard history"}</h3></div>
              {clipboardHistory.length > 0 && (
                <button type="button" onClick={() => {
                  void invoke("clear_clipboard_history")
                    .then(() => setClipboardHistory([]))
                    .catch((reason) => setClipboardHistoryError(errorMessage(reason)));
                }}>{language === "ru" ? "Очистить" : "Clear"}</button>
              )}
            </div>
            {clipboardHistory.length === 0 ? (
              <div className="empty-state"><span><Icon name="clipboard" size={19} /></span><b>{language === "ru" ? "История пока пуста" : "History is empty"}</b><p>{language === "ru" ? "Здесь появится отправленный и полученный текст." : "Sent and received text will appear here."}</p></div>
            ) : clipboardHistory.map((item) => (
              <div className="clipboard-history-entry" key={item.id}>
                <button
                  type="button"
                  className="clipboard-history-row"
                  title={language === "ru" ? "Скопировать снова" : "Copy again"}
                  onClick={() => void navigator.clipboard.writeText(item.text)}
                  onContextMenu={(event) => openContextMenu(event, [
                  { label: contextLabels.copy, icon: "clipboard", run: () => void navigator.clipboard.writeText(item.text) },
                  { label: contextLabels.send, icon: "transfer", disabled: !activeServerId, run: () => openQuickShare(item.text) },
                  {
                    label: contextLabels.remove,
                    icon: "trash",
                    danger: true,
                    run: () => {
                      void invoke<ClipboardHistoryEntry[]>("remove_clipboard_history", { id: item.id })
                        .then(setClipboardHistory)
                        .catch((reason) => setClipboardHistoryError(errorMessage(reason)));
                    },
                  },
                  ])}
                >
                  <span>{item.direction === "received" ? "↓" : "↑"}</span>
                  <span><b>{item.text}</b><small>{new Date(item.createdAt).toLocaleString()}</small></span>
                </button>
                <button type="button" className="clipboard-history-share" disabled={!activeServerId} onClick={() => openQuickShare(item.text)} aria-label={language === "ru" ? "Отправить на устройство" : "Send to a device"} title={language === "ru" ? "Отправить на устройство" : "Send to a device"}>
                  <Icon name="transfer" size={17} />
                </button>
              </div>
            ))}
            {clipboardHistoryError && <p className="setting-error" role="alert">{clipboardHistoryError}</p>}
          </article>
        </section>
      )}

      {activeSection === "transfers" && (
        <section className="section-stack" aria-label="Transfers">
          {activeServerId && profiles.some((profile) => profile.serverId === activeServerId && !profile.fileBatchApproved) && (
            <article className="glass-card">
              <p>{language === "ru" ? "Чтобы принимать несколько файлов одним пакетом, подтвердите новое разрешение в настройках подключения. Обычная отправка и приём отдельных файлов доступны." : "To receive file batches, approve the new permission in connection settings. Individual file transfers remain available."}</p>
              <button type="button" onClick={() => setActiveSection("settings")}>{language === "ru" ? "Настройки подключения" : "Connection settings"}</button>
            </article>
          )}
          {activeServerId && (shareBatches.length > 0 || localBatches.length > 0 || batchError) && (
            <article className="glass-card transfer-list">
              <div className="section-heading"><div><p className="eyebrow">HOMEPLACE LINK</p><h3>{language === "ru" ? "Пакеты файлов" : "File batches"}</h3></div>
                <span>{shareBatches.filter((batch) => batch.status === "offered").length}</span></div>
              {shareBatches.map((batch) => (
                <div className="transfer-row" key={batch.id}>
                  <span aria-hidden>↓</span>
                  <div><b>{batch.files.length} {language === "ru" ? "файлов" : "files"}</b>
                    <small>{batch.files.map((file) => file.filename).join(", ")}</small>
                    <small>{batch.files.filter((file) => file.received).length}/{batch.files.length} {language === "ru" ? "получено" : "received"}</small>
                  </div>
                  {batch.status === "offered" ? <>
                    <button type="button" disabled={batchBusy !== null} onClick={() => void handleBatch(batch, "accept")}>{language === "ru" ? "Принять в папку" : "Accept to folder"}</button>
                    <button type="button" disabled={batchBusy !== null} onClick={() => void handleBatch(batch, "reject")}>{ui.transfers.decline}</button>
                  </> : batch.status === "accepted" ? <>
                    <button type="button" disabled={batchBusy !== null} onClick={() => void handleBatch(batch, "resume")}>{language === "ru" ? "Продолжить" : "Resume"}</button>
                    <button type="button" disabled={batchBusy !== null} onClick={() => void handleBatch(batch, "accept")}>{language === "ru" ? "Выбрать папку" : "Choose folder"}</button>
                  </> : null}
                </div>
              ))}
              {localBatches.map((item) => <div className="transfer-row" key={item.requestKey}>
                <span aria-hidden>↑</span><div><b>{item.fileCount} {language === "ru" ? "файлов — отправка не завершена" : "files — sending incomplete"}</b></div>
                <button type="button" disabled={batchBusy !== null} onClick={() => void resumeLocalBatch(item)}>{language === "ru" ? "Продолжить" : "Resume"}</button>
              </div>)}
              {batchError && <p className="setting-error" role="alert">{batchError}</p>}
            </article>
          )}
          <article className="glass-card transfer-list">
            <div className="section-heading"><div><p className="eyebrow">{ui.transfers.inbox}</p><h3>{ui.transfers.waiting}</h3></div><span>{offers.length}</span></div>
            {offers.length === 0 ? (
              <div className="empty-state"><span><Icon name="check" size={19} /></span><b>{ui.transfers.empty}</b><p>{ui.transfers.emptyHint}</p></div>
            ) : offers.map((offer) => (
              <div
                className="transfer-row"
                key={offer.id}
                onContextMenu={(event) => openContextMenu(event, [
                  {
                    label: contextLabels.accept,
                    icon: "check",
                    disabled: offerBusy !== null,
                    run: () => void handleOffer(offer, offer.kind === "url" ? "open" : offer.kind === "file" ? "save" : "copy"),
                  },
                  { label: contextLabels.decline, icon: "trash", danger: true, disabled: offerBusy !== null, run: () => void handleOffer(offer, "decline") },
                ])}
              >
                <span>{offer.kind === "url" ? "↗" : offer.kind === "file" ? "↓" : "T"}</span>
                <div><b>{offer.kind === "url" ? ui.transfers.open : offer.kind === "file" ? ui.transfers.save : ui.transfers.copy}</b><small>{ui.transfers.from} {offer.sourceName}</small></div>
                <button type="button" disabled={offerBusy !== null} onClick={() => void handleOffer(offer, offer.kind === "url" ? "open" : offer.kind === "file" ? "save" : "copy")}>{ui.transfers.accept}</button>
                <button type="button" disabled={offerBusy !== null} onClick={() => void handleOffer(offer, "decline")}>{ui.transfers.decline}</button>
              </div>
            ))}
          </article>
          {transferHistory.length > 0 && (
            <article className="glass-card transfer-list transfer-history">
              <div className="section-heading">
                <div><p className="eyebrow">{ui.transfers.title}</p><h3>{language === "ru" ? "История" : "History"}</h3></div>
                <button type="button" onClick={() => setTransferHistory([])}>{language === "ru" ? "Очистить" : "Clear"}</button>
              </div>
              {transferHistory.map((item) => (
                <div
                  className="transfer-row"
                  key={`${item.id}:${item.resolvedAt}`}
                  onContextMenu={(event) => openContextMenu(event, [
                    {
                      label: contextLabels.copy,
                      icon: "clipboard",
                      run: () => void navigator.clipboard.writeText(item.filename ?? item.sourceName),
                    },
                    {
                      label: contextLabels.remove,
                      icon: "trash",
                      danger: true,
                      run: () => setTransferHistory((current) => current.filter((entry) => entry !== item)),
                    },
                    {
                      label: contextLabels.clear,
                      icon: "trash",
                      danger: true,
                      run: () => setTransferHistory([]),
                    },
                  ])}
                >
                  <span>{item.kind === "url" ? "↗" : item.kind === "file" ? "↓" : "T"}</span>
                  <div>
                    <b>{item.filename ?? (item.kind === "url" ? ui.transfers.open : item.kind === "text" ? ui.transfers.copy : ui.transfers.save)}</b>
                    <small>{ui.transfers.from} {item.sourceName} · {new Date(item.resolvedAt).toLocaleString()}</small>
                  </div>
                  <em>{item.action === "decline" ? ui.transfers.decline : ui.transfers.accept}</em>
                </div>
              ))}
            </article>
          )}
          <div className="transfer-mode-switch" role="tablist" aria-label={language === "ru" ? "Способ отправки" : "Sharing method"}>
            <button type="button" role="tab" aria-selected={transferMode === "devices"} className={transferMode === "devices" ? "active" : undefined} onClick={() => setTransferMode("devices")}>{language === "ru" ? "На устройство" : "To a device"}</button>
            <button type="button" role="tab" aria-selected={transferMode === "exchange"} className={transferMode === "exchange" ? "active" : undefined} onClick={() => setTransferMode("exchange")}>{language === "ru" ? "Временная ссылка" : "Temporary link"}</button>
          </div>
          {transferMode === "devices" ? <ShareComposer language={language} /> : activeServerId ? (
            <TemporaryExchange
              key={`${activeServerId}:${exchangeDraft && (exchangeDraft.serverId === activeServerId || exchangeDraft.serverId === null) ? exchangeDraft.revision : "fresh"}`}
              language={language}
              gateway={exchangeGateway}
              expiryOptions={exchangeExpiryOptions(language)}
              initialContent={exchangeDraft && (exchangeDraft.serverId === activeServerId || exchangeDraft.serverId === null) ? exchangeDraft.content : null}
              onChooseFile={async () => {
                const path = await invoke<string | null>("pick_exchange_file");
                return path ? { path, name: path.split(/[\\/]/).pop() || path } : null;
              }}
            />
          ) : <p className="setting-error">{language === "ru" ? "Подключите HomePlace в настройках, чтобы создавать временные ссылки." : "Connect HomePlace in Settings to create temporary links."}</p>}
        </section>
      )}

      {activeSection === "automations" && (
        <section className="section-stack" aria-label="Automations">
          <article className="overview-start roadmap-note">
            <span className="overview-start-mark"><Icon name="automation" size={27} /></span>
            <p className="eyebrow">HOMEPLACE LINK</p>
            <h2>{language === "ru" ? "Правила между устройствами" : "Rules between devices"}</h2>
            <p>{language === "ru" ? "Автоматизации ещё не доступны в Desktop. Здесь появятся сценарии для устройств и домашних сервисов, когда сервер начнёт ими управлять." : "Desktop automations are not available yet. Device and home-service rules will appear here when the server supports them."}</p>
          </article>
        </section>
      )}

      {activeSection === "productivity" && (
        <section className="section-stack productivity-page" aria-label="Productivity">
          <div className="productivity-layout">
            <article className="glass-card calendar-card">
              <div className="section-heading calendar-heading">
                <div>
                  <p className="eyebrow">{ui.productivity.calendar}</p>
                  <h3>{monthLabel}</h3>
                </div>
                <div className="calendar-actions" aria-label={language === "ru" ? "Навигация по календарю" : "Calendar navigation"}>
                  <button type="button" onClick={() => moveCalendarMonth(-1)} aria-label={ui.productivity.previousMonth}>‹</button>
                  <button type="button" onClick={showCurrentCalendarMonth}>{ui.productivity.today}</button>
                  <button type="button" onClick={() => moveCalendarMonth(1)} aria-label={ui.productivity.nextMonth}>›</button>
                </div>
              </div>
              <div className="calendar-weekdays" aria-hidden>
                {(language === "ru"
                  ? ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
                  : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                ).map((day) => <span key={day}>{day}</span>)}
              </div>
              <div className="calendar-grid" aria-label={monthLabel}>
                {calendarDays.map((day) => (
                  <button
                    type="button"
                    key={day.key}
                    className={`${day.currentMonth ? "" : "outside"} ${day.isToday ? "today" : ""} ${day.key === selectedCalendarDay ? "selected" : ""}`}
                    onClick={() => setSelectedCalendarDay(day.key)}
                    aria-current={day.isToday ? "date" : undefined}
                    aria-label={`${day.key}${day.eventCount ? `, ${day.eventCount} ${ui.productivity.events}` : ""}`}
                  >
                    {day.day}
                    {day.eventCount > 0 && <i className="calendar-event-dot" aria-hidden />}
                  </button>
                ))}
              </div>
              <div className="calendar-source-row">
                <span><i className={`source-dot personal ${calendarStatus === "connected" ? "connected" : ""}`} />{ui.productivity.googleCalendar}</span>
                <small>{calendarStatus === "connected" ? ui.productivity.calendarConnected : calendarStatus === "unavailable" ? ui.productivity.calendarUnavailable : ui.productivity.calendarNotConnected}</small>
              </div>
              {showCalendarForm && (
                <form className="calendar-form" onSubmit={submitCalendarEvent}>
                  <input value={calendarTitle} onChange={(event) => setCalendarTitle(event.target.value)} placeholder={ui.productivity.eventTitle} maxLength={300} autoFocus required />
                  <input value={calendarLocation} onChange={(event) => setCalendarLocation(event.target.value)} placeholder={ui.productivity.location} maxLength={300} />
                  <label className="calendar-all-day"><input type="checkbox" checked={calendarAllDay} onChange={(event) => changeCalendarAllDay(event.target.checked)} /> {ui.productivity.allDay}</label>
                  <label><span>{ui.productivity.starts}</span><input type={calendarAllDay ? "date" : "datetime-local"} value={calendarStart} onChange={(event) => setCalendarStart(event.target.value)} required /></label>
                  <label><span>{ui.productivity.ends}</span><input type={calendarAllDay ? "date" : "datetime-local"} value={calendarEnd} onChange={(event) => setCalendarEnd(event.target.value)} required /></label>
                  <div className="calendar-form-actions">
                    <button type="button" onClick={() => setShowCalendarForm(false)}>{ui.productivity.cancel}</button>
                    <button type="submit" disabled={calendarBusy || !calendarTitle.trim()}>{editingCalendarEventId ? ui.productivity.save : ui.productivity.add}</button>
                  </div>
                </form>
              )}
            </article>

            <aside className="productivity-side">
              <article className="glass-card agenda-card">
                <div className="section-heading">
                  <div><p className="eyebrow">{selectedCalendarDate.toLocaleDateString(language === "ru" ? "ru-RU" : "en-US", { weekday: "long" })}</p><h3>{ui.productivity.agenda}</h3></div>
                  <span>{selectedCalendarDate.getDate()}</span>
                </div>
                {!activeServerId ? (
                  <div className="agenda-empty"><span>□</span><b>{ui.productivity.calendarNotConnected}</b></div>
                ) : !calendarLoaded ? (
                  <div className="agenda-empty"><span>◌</span><b>{ui.productivity.calendarLoading}</b></div>
                ) : calendarError ? (
                  <div className="agenda-empty calendar-error"><span>!</span><b>{calendarError.includes("permission") || calendarError.includes("approved") ? ui.productivity.calendarPermission : ui.productivity.calendarUnavailable}</b></div>
                ) : selectedCalendarEvents.length === 0 ? (
                  <div className="agenda-empty">
                    <span>□</span>
                    <b>{ui.productivity.clear}</b>
                    <p>{calendarStatus === "not_connected" ? ui.productivity.calendarNotConnected : ui.productivity.clearHint}</p>
                  </div>
                ) : (
                  <div className="agenda-list">
                    {selectedCalendarEvents.map((event) => (
                    <div
                      className="agenda-item"
                      key={event.id}
                      onContextMenu={(menuEvent) => openContextMenu(menuEvent, [
                        { label: contextLabels.edit, icon: "edit", disabled: calendarBusy, run: () => editCalendarEvent(event) },
                        {
                          label: contextLabels.copy,
                          icon: "clipboard",
                          run: () => void navigator.clipboard.writeText(`${event.summary}${event.location ? ` · ${event.location}` : ""}`),
                        },
                        { label: contextLabels.duplicate, icon: "plus", disabled: calendarBusy, run: () => void duplicateCalendarEvent(event) },
                        { label: contextLabels.tomorrow, icon: "calendar", disabled: calendarBusy, run: () => void moveCalendarEventToTomorrow(event) },
                        { label: contextLabels.remove, icon: "trash", danger: true, disabled: calendarBusy, run: () => void removeCalendarEvent(event.id) },
                      ])}
                    >
                        <time>{event.allDay ? ui.productivity.allDay : new Date(event.start).toLocaleTimeString(language === "ru" ? "ru-RU" : "en-US", { hour: "2-digit", minute: "2-digit" })}</time>
                        <span><b>{event.summary || ui.productivity.untitledEvent}</b>{event.location && <small>{event.location}</small>}</span>
                        <div className="agenda-item-actions">
                          <button type="button" disabled={calendarBusy} onClick={() => editCalendarEvent(event)}>{ui.productivity.edit}</button>
                          <button type="button" disabled={calendarBusy} onClick={() => void removeCalendarEvent(event.id)}>{ui.productivity.delete}</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <button type="button" className="subtle-action" disabled={!activeServerId || calendarBusy || calendarStatus !== "connected"} onClick={createCalendarEventForSelectedDay}><Icon name="plus" size={13} /> {ui.productivity.addEvent}</button>
              </article>

              <article className="glass-card focus-card">
                <div>
                  <p className="eyebrow">{ui.productivity.focus}</p>
                  <h3>25:00</h3>
                  <small>{ui.productivity.focusHint}</small>
                </div>
                <button type="button" disabled>{ui.productivity.start}</button>
              </article>
            </aside>
          </div>

          <article className="glass-card reminders-card">
            <div className="section-heading">
              <div><p className="eyebrow">{ui.productivity.reminders}</p><h3>{ui.productivity.tasks}</h3></div>
              <button
                type="button"
                className="subtle-action"
                disabled={!activeServerId || reminderBusy}
                onClick={() => addingReminder ? closeReminderForm() : setAddingReminder(true)}
              >
                <Icon name="plus" size={13} /> {addingReminder ? ui.productivity.cancel : ui.productivity.newReminder}
              </button>
            </div>
            {addingReminder && (
              <form className="reminder-form" onSubmit={submitReminder}>
                <input
                  value={reminderTitle}
                  onChange={(event) => setReminderTitle(event.target.value)}
                  placeholder={ui.productivity.what}
                  maxLength={200}
                  autoFocus
                  required
                />
                <label>
                  <span>{ui.productivity.when}</span>
                  <input type="datetime-local" value={reminderAt} onChange={(event) => setReminderAt(event.target.value)} required />
                </label>
                <label>
                  <span>{ui.productivity.repeat}</span>
                  <select
                    value={reminderRepeat.startsWith("every:") ? "custom" : reminderRepeat}
                    onChange={(event) => setReminderRepeat(event.target.value === "custom" ? "every:2:day" : event.target.value)}
                  >
                    <option value="none">{ui.productivity.once}</option>
                    <option value="hourly">{ui.productivity.hourly}</option>
                    <option value="daily">{ui.productivity.daily}</option>
                    <option value="weekly">{ui.productivity.weekly}</option>
                    <option value="monthly">{ui.productivity.monthly}</option>
                    <option value="yearly">{ui.productivity.yearly}</option>
                    <option value="custom">{language === "ru" ? "Свой интервал…" : "Custom interval…"}</option>
                  </select>
                </label>
                {reminderRepeat.startsWith("every:") && (
                  <label className="reminder-custom-repeat">
                    <span>{language === "ru" ? "Каждые" : "Every"}</span>
                    <span>
                      <input
                        type="number"
                        min="2"
                        max="999"
                        value={reminderRepeat.split(":")[1] || "2"}
                        onChange={(event) => setReminderRepeat(`every:${Math.max(2, Math.min(999, Number(event.target.value) || 2))}:${reminderRepeat.split(":")[2] || "day"}`)}
                        aria-label={language === "ru" ? "Количество" : "Interval count"}
                      />
                      <select
                        value={reminderRepeat.split(":")[2] || "day"}
                        onChange={(event) => setReminderRepeat(`every:${reminderRepeat.split(":")[1] || "2"}:${event.target.value}`)}
                        aria-label={language === "ru" ? "Единица интервала" : "Interval unit"}
                      >
                        <option value="hour">{language === "ru" ? "часа/часов" : "hours"}</option>
                        <option value="day">{language === "ru" ? "дня/дней" : "days"}</option>
                        <option value="week">{language === "ru" ? "недели/недель" : "weeks"}</option>
                        <option value="month">{language === "ru" ? "месяца/месяцев" : "months"}</option>
                        <option value="year">{language === "ru" ? "года/лет" : "years"}</option>
                      </select>
                    </span>
                  </label>
                )}
                <button type="submit" disabled={reminderBusy || !reminderTitle.trim()}>{editingReminderId ? ui.productivity.save : ui.productivity.add}</button>
              </form>
            )}
            {reminderError && (
              <p className="reminder-error" role="alert">
                {reminderError.includes("permission") ? ui.productivity.permission : reminderError}
              </p>
            )}
          <div className="reminder-grid">
            <div
              className={`reminder-column overdue-column${reminderDropTarget === "overdue" ? " drop-target" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setReminderDropTarget("overdue"); }}
              onDragLeave={() => setReminderDropTarget(null)}
              onDrop={(event) => { event.preventDefault(); dropReminder("overdue"); }}
            >
              <b>{ui.productivity.overdue}</b>
              {reminderRows(overdueReminders)}
            </div>
            <div
              className={`reminder-column${reminderDropTarget === "today" ? " drop-target" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setReminderDropTarget("today"); }}
              onDragLeave={() => setReminderDropTarget(null)}
              onDrop={(event) => { event.preventDefault(); dropReminder("today"); }}
            >
              <b>{ui.productivity.today}</b>
              {reminderRows(todayReminders)}
            </div>
            <div
              className={`reminder-column${reminderDropTarget === "upcoming" ? " drop-target" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setReminderDropTarget("upcoming"); }}
              onDragLeave={() => setReminderDropTarget(null)}
              onDrop={(event) => { event.preventDefault(); dropReminder("upcoming"); }}
            >
              <b>{ui.productivity.upcoming}</b>
              {reminderRows(upcomingReminders)}
            </div>
            <div className="reminder-column completed-column">
              <div className="reminder-column-heading">
                <b>{language === "ru" ? "Выполненные" : "Completed"}</b>
                {completedReminders.length > 0 && <button type="button" disabled={reminderBusy} onClick={() => void clearCompletedReminderHistory()}>{language === "ru" ? "Очистить" : "Clear"}</button>}
              </div>
              {completedReminderRows()}
            </div>
          </div>
        </article>

        <IdeasBoard key={activeServerId ?? "unpaired"} language={language} activeServerId={activeServerId} onOpenConnections={() => setActiveSection("settings")} onMakeReminder={(value) => { setReminderTitle(value.slice(0, 200)); setReminderAt(defaultReminderTime()); setReminderRepeat("none"); setAddingReminder(true); }} openContextMenu={openContextMenu} />
        </section>
      )}

      {activeSection === "media" && <MediaCatalog key={activeServerId ?? "unpaired"} activeServerId={activeServerId} language={language} onOpenConnections={() => setActiveSection("settings")} />}
      {activeSection === "monitoring" && <ServerWorkspace key={activeServerId ?? "unpaired"} kind="monitoring" language={language} activeServerId={activeServerId} onOpenConnections={() => setActiveSection("settings")} />}
      {activeSection === "notifications" && (
        <section className="section-stack" aria-label="Notifications">
          <section className="metric-grid notification-metrics">
            <article className="glass-card metric-card"><span><Icon name="check" size={21} /></span><strong>{deliveredNotifications}</strong><small>{ui.notifications.delivered}</small></article>
            <article className="glass-card metric-card"><span>!</span><strong>{notificationFailures}</strong><small>{ui.notifications.attention}</small></article>
            <article className="glass-card metric-card"><span><Icon name="bell" size={21} /></span><strong>{lastHeartbeat ? ui.notifications.live : "—"}</strong><small>{ui.notifications.channel}</small></article>
          </section>
          <article className="glass-card settings-panel">
            <div className="section-heading"><div><p className="eyebrow">{ui.notifications.delivery}</p><h3>{ui.notifications.routes}</h3></div></div>
            <label className="settings-row"><span><b>{ui.notifications.desktop}</b><small>{ui.notifications.desktopHint}</small></span><input type="checkbox" checked={systemNotificationsEnabled} disabled={!systemNotificationsLoaded || systemNotificationsBusy || !activeServerId} onChange={(event) => void updateSystemNotifications(event.target.checked)} /></label>
            {systemNotificationsError && <p className="setting-error" role="alert">{systemNotificationsError}</p>}
          </article>
          <NotificationHistory key={activeServerId ?? "unpaired"} language={language} activeServerId={activeServerId} onOpenPlant={(id) => { setRequestedPlantId(id); setActiveSection("overview"); }} />
          <TelegramStatus key={activeServerId ?? "unpaired"} activeServerId={activeServerId} language={language} />
        </section>
      )}

      {activeSection === "settings" && (
        <section className="section-stack" aria-label="Settings">
          <article className="glass-card settings-panel appearance-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">{language === "ru" ? "Интерфейс" : "Interface"}</p>
                <h3>{language === "ru" ? "Внешний вид" : "Appearance"}</h3>
              </div>
            </div>
            <div className="theme-choices" role="group" aria-label={language === "ru" ? "Тема оформления" : "Color theme"}>
              <button type="button" className={theme === "light" ? "active" : undefined} onClick={() => setTheme("light")}>
                <span className="theme-preview light-preview" aria-hidden><i /><i /><i /></span>
                <b>{language === "ru" ? "Светлая" : "Light"}</b>
                  <small>{language === "ru" ? "Тёплые молочные оттенки" : "Warm milk-toned surfaces"}</small>
              </button>
              <button type="button" className={theme === "dark" ? "active" : undefined} onClick={() => setTheme("dark")}>
                <span className="theme-preview dark-preview" aria-hidden><i /><i /><i /></span>
                <b>{language === "ru" ? "Тёмная" : "Dark"}</b>
                <small>{language === "ru" ? "Глубокие спокойные поверхности" : "Deep, quiet surfaces"}</small>
              </button>
            </div>
          </article>
          <article className="glass-card settings-panel">
            <div className="section-heading"><div><p className="eyebrow">{ui.settings.application}</p><h3>{ui.settings.general}</h3></div></div>
            <label className="settings-row"><span><b>{ui.settings.startup}</b><small>{ui.settings.startupHint}</small></span><input type="checkbox" checked={startupEnabled} disabled={!startupLoaded || startupBusy} onChange={(event) => void updateStartup(event.target.checked)} /></label>
            <label className="settings-row"><span><b>{ui.settings.clipboard}</b><small>{ui.settings.clipboardHint}</small></span><input type="checkbox" checked={clipboardSyncEnabled} disabled={!clipboardSyncLoaded || clipboardSyncBusy || !activeServerId} onChange={(event) => void updateClipboardSync(event.target.checked)} /></label>
            {(startupError || clipboardSyncError) && <p className="setting-error">{startupError ?? clipboardSyncError}</p>}
          </article>
          <details className="glass-card settings-panel muted-panel settings-about">
            <summary><span><small>{ui.settings.about}</small><b>HomePlace Link Desktop</b></span><span>v0.1.0</span></summary>
            <p>Protocol v1 · {ui.settings.companion} {platform.label}</p>
          </details>
        </section>
      )}

      </div>

      {contextMenu && (
        <>
          <button
            type="button"
            className="context-menu-backdrop"
            aria-label={contextLabels.close}
            onClick={() => setContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
          />
          <div
            className="context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            {contextMenu.actions.map((action, index) => (
              <button
                type="button"
                role="menuitem"
                className={action.danger ? "danger" : undefined}
                disabled={action.disabled}
                key={`${action.label}:${index}`}
                onClick={() => {
                  setContextMenu(null);
                  action.run();
                }}
              >
                <Icon name={action.icon} size={15} />
                <span>{action.label}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {incomingOffer && (
        <section className="incoming-offer-backdrop" role="dialog" aria-modal="true" aria-labelledby="incoming-offer-title">
          <article
            className="incoming-offer-card glass-card"
            onContextMenu={(event) => openContextMenu(event, [
              {
                label: contextLabels.accept,
                icon: "check",
                disabled: offerBusy !== null,
                run: () => void handleOffer(incomingOffer, incomingOffer.kind === "url" ? "open" : incomingOffer.kind === "file" ? "save" : "copy"),
              },
              { label: contextLabels.decline, icon: "trash", danger: true, disabled: offerBusy !== null, run: () => void handleOffer(incomingOffer, "decline") },
            ])}
          >
            <button
              type="button"
              className="incoming-offer-close"
              aria-label={language === "ru" ? "Позже" : "Later"}
              title={language === "ru" ? "Позже" : "Later"}
              onClick={() => setDismissedOfferId(incomingOffer.id)}
            >
              ×
            </button>
            <span className="incoming-offer-icon" aria-hidden>
              {incomingOffer.kind === "file" ? "↓" : incomingOffer.kind === "url" ? "↗" : "T"}
            </span>
            <div>
              <p className="eyebrow">{ui.transfers.inbox}</p>
              <h2 id="incoming-offer-title">{ui.transfers.waiting}</h2>
              <p className="incoming-offer-source">{ui.transfers.from} {incomingOffer.sourceName}</p>
              {incomingOffer.filename && (
                <p className="incoming-offer-file">
                  <b>{incomingOffer.filename}</b>
                  {typeof incomingOffer.size === "number" && (
                    <small>{(incomingOffer.size / 1024 / 1024).toFixed(incomingOffer.size >= 1024 * 1024 ? 1 : 2)} MiB</small>
                  )}
                </p>
              )}
            </div>
            <div className="incoming-offer-actions">
              <button type="button" disabled={offerBusy !== null} onClick={() => void handleOffer(incomingOffer, "decline")}>{ui.transfers.decline}</button>
              <button
                type="button"
                className="primary-action"
                disabled={offerBusy !== null}
                onClick={() => void handleOffer(incomingOffer, incomingOffer.kind === "url" ? "open" : incomingOffer.kind === "file" ? "save" : "copy")}
              >
                {offerBusy === incomingOffer.id ? ui.devices.working : ui.transfers.accept}
              </button>
            </div>
            {offerError && <p className="setting-error" role="alert">{offerError}</p>}
          </article>
        </section>
      )}
    </main>
  );
}

function ShareComposer({ language }: { language: Language }) {
  const fileLimit = useFileTransferLimit();
  const [targets, setTargets] = useState<ShareTarget[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [transferProgress, setTransferProgress] = useState<ActiveTransferProgress | null>(null);

  function loadTargets() {
    void invoke<ShareTarget[]>("list_share_targets")
      .then(setTargets)
      .catch((reason) => setError(errorMessage(reason)));
  }

  function stageFiles(paths: string[]) {
    const unique = [...new Set(paths)].slice(0, 20);
    if (unique.length === 0) return;
    setFiles(unique);
    setText("");
    setSent(false);
    setTransferProgress(null);
    setError(null);
  }

  useEffect(() => {
    loadTargets();
    if (!isTauriRuntime) return;
    let cancelled = false;
    let stopDrop: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setDragging(true);
      } else if (event.payload.type === "leave") {
        setDragging(false);
      } else if (event.payload.type === "drop") {
        setDragging(false);
        stageFiles(event.payload.paths);
      }
    }).then((unlisten) => {
      if (cancelled) unlisten(); else stopDrop = unlisten;
    });
    return () => {
      cancelled = true;
      stopDrop?.();
    };
  }, []);

  async function chooseFiles() {
    try {
      const selected = await invoke<string[]>("pick_share_files");
      stageFiles(selected);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function send(target: ShareTarget) {
    const trimmed = text.trim();
    if (busy || (files.length === 0 && !trimmed)) return;
    setBusy(target.id);
    setSent(false);
    setTransferProgress(null);
    setError(null);
    try {
      if (files.length > 0) {
        if (files.length > 1) {
          const stopProgress = await listen<FileBatchProgress>("link-file-batch-progress", ({ payload: progress }) => {
            setTransferProgress({ transferId: progress.batchId, fileName: progress.fileName,
              transferredBytes: progress.transferredBytes, totalBytes: progress.totalBytes,
              fileIndex: progress.fileIndex - 1, fileCount: progress.fileCount, targetName: target.name });
          });
          try {
            await invoke("send_share_batch", { targetDeviceId: target.id, filePaths: files });
          } finally { stopProgress(); }
        } else for (const [fileIndex, filePath] of files.entries()) {
          const transferId = newTransferId();
          const fileName = filePath.split(/[\\/]/).pop() || filePath;
          setTransferProgress({ transferId, fileName, transferredBytes: 0, totalBytes: 0, fileIndex, fileCount: files.length, targetName: target.name });
          const stopProgress = await listen<FileTransferProgress>("link-file-transfer-progress", ({ payload: progress }) => {
            if (progress.transferId !== transferId) return;
            setTransferProgress({ ...progress, fileIndex, fileCount: files.length, targetName: target.name });
          });
          try {
            await invoke("send_share_file", { targetDeviceId: target.id, filePath, transferId });
          } finally {
            stopProgress();
          }
        }
      } else {
        await invoke("send_share_text", {
          targetDeviceId: target.id,
          kind: /^https?:\/\/\S+$/i.test(trimmed) ? "url" : "text",
          value: trimmed,
        });
      }
      setFiles([]);
      setText("");
      setSent(true);
      setTransferProgress(null);
      loadTargets();
    } catch (reason) {
      setError(errorMessage(reason));
      setTransferProgress(null);
    } finally {
      setBusy(null);
    }
  }

  const hasPayload = files.length > 0 || text.trim().length > 0;
  const compatible = targets.filter((target) => files.length > 0
    ? target.supportsFile
    : /^https?:\/\/\S+$/i.test(text.trim())
      ? target.supportsUrl
      : target.supportsText);

  return (
    <article className="glass-card share-composer">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{language === "ru" ? "Новая передача" : "New transfer"}</p>
          <h3>{language === "ru" ? "Отправить файл, текст или ссылку" : "Send a file, text, or link"}</h3>
        </div>
        <span>{files.length > 0 ? files.length : hasPayload ? 1 : 0}</span>
      </div>

      <button
        type="button"
        className={`share-drop-zone${dragging ? " dragging" : ""}`}
        onClick={() => void chooseFiles()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const dropped = event.dataTransfer.getData("text/plain");
          if (dropped) {
            setFiles([]);
            setText(dropped.slice(0, 8_000));
          }
        }}
      >
        <Icon name="transfer" size={24} />
        <span>
          <b>{dragging ? (language === "ru" ? "Отпустите файлы здесь" : "Drop files here") : (language === "ru" ? "Перетащите файлы или выберите их" : "Drop files or choose them")}</b>
          <small>{language === "ru" ? `До 20 файлов, каждый до ${fileLimitLabel(fileLimit, language)}` : `Up to 20 files, each up to ${fileLimitLabel(fileLimit, language)}`}</small>
        </span>
      </button>

      {files.length > 0 ? (
        <div className="share-file-list">
          {files.map((filePath) => (
            <div className="quick-share-payload" key={filePath}>
              <Icon name="transfer" size={17} />
              <span><b>{filePath.split(/[\\/]/).pop() || filePath}</b><small>{language === "ru" ? "Готов к отправке" : "Ready to send"}</small></span>
              <button type="button" onClick={() => setFiles((current) => current.filter((path) => path !== filePath))}>×</button>
            </div>
          ))}
        </div>
      ) : (
        <textarea
          value={text}
          maxLength={8_000}
          rows={4}
          placeholder={language === "ru" ? "Или вставьте текст или ссылку" : "Or paste text or a link"}
          onChange={(event) => {
            setText(event.target.value);
            setSent(false);
            setError(null);
          }}
        />
      )}

      {transferProgress && <TransferProgressPanel progress={transferProgress} language={language} />}

      <div className="share-composer-targets quick-share-targets">
        {compatible.map((target) => (
          <button type="button" key={target.id} disabled={!hasPayload || busy !== null} onClick={() => void send(target)}>
            <span className={target.online ? "online" : undefined}><Icon name="devices" size={17} /></span>
            <span><b>{target.name}</b><small>{target.ownerName} · {target.platform}</small></span>
            <em>{busy === target.id && transferProgress ? <TransferProgressRing progress={transferProgress} compact /> : busy === target.id ? "…" : "→"}</em>
          </button>
        ))}
        {compatible.length === 0 && <p>{language === "ru" ? "Нет устройств с подходящими разрешениями." : "No devices have the required sharing permission."}</p>}
      </div>
      {sent && <p className="quick-share-success">{language === "ru" ? "Отправлено — получатель увидит системное уведомление." : "Sent — the recipient will see a system notification."}</p>}
      {error && <p className="setting-error" role="alert">{error}</p>}
    </article>
  );
}

function QuickShareWindow() {
  const fileLimit = useFileTransferLimit();
  const [language] = useState<Language>(() => {
    const saved = window.localStorage.getItem("homeplace-language");
    return saved === "en" || saved === "ru" ? saved : navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
  });
  const [targets, setTargets] = useState<ShareTarget[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [payload, setPayload] = useState<QuickSharePayload | null>(null);
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [transferProgress, setTransferProgress] = useState<ActiveTransferProgress | null>(null);
  const [visible, setVisible] = useState(false);
  const busyRef = useRef<string | null>(null);
  const payloadRef = useRef<QuickSharePayload | null>(null);
  const sentRef = useRef(false);
  const errorRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    busyRef.current = busy;
    payloadRef.current = payload;
    sentRef.current = sent;
    errorRef.current = error;
  }, [busy, payload, sent, error]);
  const motion = useRef<QuickShareLifecycle | null>(null);
  if (motion.current === null) {
    motion.current = new QuickShareLifecycle(setVisible, () => {
      void getCurrentWindow().hide();
      void invoke("set_quick_share_pinned", { pinned: false });
      setPayload(null);
      setText("");
      setExpanded(false);
      setSent(false);
      setTransferProgress(null);
      setError(null);
    });
  }

  const loadTargets = useCallback(() => {
    setError(null);
    setTargetsLoading(true);
    void invoke<ShareTarget[]>("list_share_targets")
      .then(setTargets)
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setTargetsLoading(false));
  }, []);

  const stageText = useCallback((value: string) => {
    if (busyRef.current) return;
    motion.current?.open();
    setText(value);
    setSent(false);
    setTransferProgress(null);
    setError(null);
    const trimmed = value.trim();
    if (!trimmed) return setPayload(null);
    setExpanded(true);
    setPayload({ kind: /^https?:\/\/\S+$/i.test(trimmed) ? "url" : "text", value: trimmed, label: trimmed });
  }, []);

  const stageFiles = useCallback((paths: string[]) => {
    if (busyRef.current) return;
    const unique = [...new Set(paths)];
    if (unique.length === 0) return;
    motion.current?.open();
    if (unique.length > 20) {
      setExpanded(true);
      setError(language === "ru" ? "Выберите не больше 20 файлов за одну отправку." : "Choose up to 20 files per transfer.");
      return;
    }
    const firstName = unique[0].split(/[\\/]/).pop() || unique[0];
    setPayload({
      kind: "files",
      paths: unique,
      label: unique.length === 1 ? firstName : `${firstName} +${unique.length - 1}`,
    });
    setText("");
    setExpanded(true);
    setSent(false);
    setTransferProgress(null);
    setError(null);
    loadTargets();
  }, [loadTargets, language]);

  useEffect(() => {
    let cancelled = false;
    let stopOpen: (() => void) | undefined;
    let stopStage: (() => void) | undefined;
    let stopStageFiles: (() => void) | undefined;
    let stopNativeStage: (() => void) | undefined;
    let stopDragState: (() => void) | undefined;
    let stopDrop: (() => void) | undefined;
    let stopClose: (() => void) | undefined;
    const consumeNativeShare = () => {
      void invoke<PendingNativeShare | null>("take_pending_share").then((pending) => {
        if (cancelled || !pending) return;
        if (pending.files.length > 0) stageFiles(pending.files);
        else if (pending.text) stageText(pending.text);
      });
    };
    void listen<boolean>("quick-share-opened", ({ payload: shouldExpand }) => {
      if (!cancelled) {
        motion.current?.open();
        setExpanded(shouldExpand || payloadRef.current !== null || busyRef.current !== null);
        if (!busyRef.current) setSent(false);
        loadTargets();
      }
    }).then((unlisten) => {
      if (cancelled) unlisten(); else stopOpen = unlisten;
    });
    void listen<boolean>("quick-share-close-requested", ({ payload: explicit }) => {
      if (!cancelled && !busyRef.current && (explicit || (!payloadRef.current && !sentRef.current && !errorRef.current))) motion.current?.close();
    }).then((unlisten) => {
      if (cancelled) unlisten(); else stopClose = unlisten;
    });
    void getCurrentWindow().isVisible().then((shown) => {
      if (!cancelled && shown) motion.current?.open();
    });
    void listen<string>("quick-share-stage-text", ({ payload: stagedText }) => {
      if (!cancelled) stageText(stagedText);
    }).then((unlisten) => {
      if (cancelled) unlisten(); else stopStage = unlisten;
    });
    void listen<string[]>("quick-share-stage-files", ({ payload: stagedFiles }) => {
      if (!cancelled) stageFiles(stagedFiles);
    }).then((unlisten) => {
      if (cancelled) unlisten(); else stopStageFiles = unlisten;
    });
    void listen("quick-share-staged", consumeNativeShare).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        stopNativeStage = unlisten;
        consumeNativeShare();
      }
    });
    void listen<boolean>("quick-share-drag-active", ({ payload: active }) => {
      if (!cancelled) {
        setDragging(active);
        if (active && !payloadRef.current && !busyRef.current) setExpanded(false);
      }
    }).then((unlisten) => {
      if (cancelled) unlisten(); else stopDragState = unlisten;
    });
    void getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setExpanded(true);
        setDragging(true);
      } else if (event.payload.type === "leave") {
        setDragging(false);
      } else if (event.payload.type === "drop") {
        setDragging(false);
        stageFiles(event.payload.paths);
      }
    }).then((unlisten) => {
      if (cancelled) unlisten(); else stopDrop = unlisten;
    });
    return () => {
      cancelled = true;
      stopOpen?.();
      stopStage?.();
      stopStageFiles?.();
      stopNativeStage?.();
      stopDragState?.();
      stopDrop?.();
      stopClose?.();
      motion.current?.dispose();
    };
  }, [loadTargets, stageFiles, stageText]);

  useEffect(() => {
    void invoke("set_quick_share_expanded", { expanded }).catch((reason) => {
      setError(errorMessage(reason));
    });
  }, [expanded]);

  useEffect(() => {
    void invoke("set_quick_share_pinned", { pinned: payload !== null || busy !== null || sent || error !== null }).catch((reason) => {
      setError(errorMessage(reason));
    });
  }, [payload, busy, sent, error]);

  const dismissShelf = useCallback(() => {
    if (!busyRef.current) motion.current?.close();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) dismissShelf();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, dismissShelf]);

  async function send(target: ShareTarget) {
    if (!payload || busy) return;
    motion.current?.open();
    busyRef.current = target.id;
    setBusy(target.id);
    setError(null);
    setSent(false);
    setTransferProgress(null);
    try {
      if (payload.kind === "files") {
        if (payload.paths.length > 1) {
          const stopProgress = await listen<FileBatchProgress>("link-file-batch-progress", ({ payload: progress }) => {
            setTransferProgress({ transferId: progress.batchId, fileName: progress.fileName,
              transferredBytes: progress.transferredBytes, totalBytes: progress.totalBytes,
              fileIndex: progress.fileIndex - 1, fileCount: progress.fileCount, targetName: target.name });
          });
          try {
            await invoke("send_share_batch", { targetDeviceId: target.id, filePaths: payload.paths });
          } finally { stopProgress(); }
        } else for (const [fileIndex, filePath] of payload.paths.entries()) {
          const transferId = newTransferId();
          const fileName = filePath.split(/[\\/]/).pop() || filePath;
          setTransferProgress({ transferId, fileName, transferredBytes: 0, totalBytes: 0, fileIndex, fileCount: payload.paths.length, targetName: target.name });
          const stopProgress = await listen<FileTransferProgress>("link-file-transfer-progress", ({ payload: progress }) => {
            if (progress.transferId !== transferId) return;
            setTransferProgress({ ...progress, fileIndex, fileCount: payload.paths.length, targetName: target.name });
          });
          try {
            await invoke("send_share_file", { targetDeviceId: target.id, filePath, transferId });
          } finally {
            stopProgress();
          }
        }
      } else {
        await invoke("send_share_text", { targetDeviceId: target.id, kind: payload.kind, value: payload.value });
      }
      setPayload(null);
      setText("");
      setTransferProgress(null);
      setSent(true);
      motion.current?.afterSuccess(dismissShelf);
    } catch (reason) {
      setError(errorMessage(reason));
      setTransferProgress(null);
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }

  const compatible = targets.filter((target) => !payload
    || (payload.kind === "files" && target.supportsFile)
    || (payload.kind === "url" && target.supportsUrl)
    || (payload.kind === "text" && target.supportsText));

  return (
    <main
      className={`tray-share-root${visible ? " visible" : " closing"}${expanded ? " expanded" : ""}${dragging ? " dragging" : ""}${busy ? " sending" : ""}${sent ? " sent" : ""}`}
      aria-busy={busy !== null}
      onMouseEnter={() => {
        setExpanded(true);
        void invoke("set_quick_share_pointer_inside", { inside: true });
      }}
      onMouseLeave={() => {
        void getCurrentWindow().isFocused().then((focused) => {
          if (!focused && !busyRef.current && !payloadRef.current && !sentRef.current) setExpanded(false);
        });
        void invoke("set_quick_share_pointer_inside", { inside: false });
      }}
    >
      <section
        className={`quick-share-shelf${expanded ? " open" : ""}${dragging ? " dragging" : ""}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const dropped = event.dataTransfer.getData("text/plain");
          if (dropped) stageText(dropped);
        }}
      >
        {!expanded && (
          <button
            type="button"
            className="quick-share-handle"
            aria-label={language === "ru" ? "Открыть быструю отправку" : "Open quick share"}
            onClick={() => setExpanded(true)}
          >
            <span className="quick-share-drop-glyph" aria-hidden>
              <i />
              <Icon name="transfer" size={22} />
              <i />
            </span>
          </button>
        )}
        {expanded && <div className="tray-share-titlebar">
          <span><Icon name="transfer" size={17} /></span>
          <div><b>{language === "ru" ? "Быстрая отправка" : "Quick share"}</b><small>HomePlace Link</small></div>
          <button type="button" disabled={busy !== null} aria-label={language === "ru" ? "Закрыть быструю отправку" : "Close quick share"} onClick={dismissShelf}>×</button>
        </div>}
        {expanded && <div className="quick-share-panel">
          <div className="quick-share-copy">
            <b>{dragging
              ? (language === "ru" ? "Отпустите — файл останется на полке" : "Drop it — the file will stay on the shelf")
              : payload ? (language === "ru" ? "Куда отправить?" : "Where should it go?")
              : (language === "ru" ? "Перетащите файлы сюда" : "Drop files here")}</b>
            <small>{dragging
              ? (language === "ru" ? "После этого спокойно выберите устройство для отправки." : "Then choose a device whenever you are ready.")
              : payload ? (language === "ru" ? "Нажмите на устройство ниже, чтобы отправить." : "Choose a device below to send.")
              : (language === "ru" ? "Или вставьте текст или ссылку, затем выберите устройство." : "Or paste text or a link, then choose a device.")}</small>
          </div>
          {payload?.kind === "files" ? (
            <div className="quick-share-payload">
              <Icon name="transfer" size={17} />
              <span><b>{payload.label}</b><small>{language === "ru" ? `${payload.paths.length} файл(ов), до ${fileLimitLabel(fileLimit, language)} каждый` : `${payload.paths.length} file(s), up to ${fileLimitLabel(fileLimit, language)} each`}</small></span>
              <button type="button" disabled={busy !== null} aria-label={language === "ru" ? "Убрать файлы с полки" : "Remove files from shelf"} onClick={() => { setPayload(null); setText(""); setError(null); setTransferProgress(null); motion.current?.open(); }}>×</button>
            </div>
          ) : (
            <textarea
              value={text}
              disabled={busy !== null}
              aria-label={language === "ru" ? "Текст или ссылка для отправки" : "Text or link to send"}
              maxLength={8000}
              rows={3}
              placeholder={language === "ru" ? "Вставьте текст или ссылку" : "Paste text or a link"}
              onChange={(event) => stageText(event.target.value)}
            />
          )}
          {transferProgress && <TransferProgressPanel progress={transferProgress} language={language} />}
          <button type="button" className="quick-share-exchange" disabled={!payload || busy !== null || (payload.kind === "files" && payload.paths.length !== 1)} onClick={() => {
            if (!payload) return;
            void invoke("open_exchange_window", {
              text: payload.kind === "files" ? null : payload.value,
              filePath: payload.kind === "files" ? payload.paths[0] : null,
            }).then(dismissShelf).catch((reason) => setError(errorMessage(reason)));
          }}>
            <Icon name="link" size={16} />
            {language === "ru" ? "Создать временную ссылку" : "Create temporary link"}
          </button>
          {payload?.kind === "files" && payload.paths.length > 1 && <p className="temporary-exchange-note">{language === "ru" ? "Для временной ссылки выберите один файл." : "Choose one file for a temporary link."}</p>}
          <div className="quick-share-targets">
            {compatible.map((target) => (
              <button type="button" key={target.id} aria-label={language === "ru" ? `Отправить на ${target.name}` : `Send to ${target.name}`} disabled={!payload || busy !== null} onClick={() => void send(target)}>
                <span className={target.online ? "online" : undefined}><Icon name={accountDeviceIcon(target.platform)} size={20} /></span>
                <span><b>{target.name}</b><small>{target.ownerName} · {target.platform}{!target.online ? (language === "ru" ? " · Не в сети" : " · Offline") : ""}</small></span>
                <em>{busy === target.id && transferProgress ? <TransferProgressRing progress={transferProgress} compact /> : busy === target.id ? "…" : "→"}</em>
              </button>
            ))}
            {compatible.length === 0 && targetsLoading && <p role="status">{language === "ru" ? "Загружаем устройства…" : "Loading devices…"}</p>}
            {compatible.length === 0 && !targetsLoading && !error && <p>{language === "ru" ? "Нет устройств с подходящими разрешениями. Проверьте быструю отправку в HomePlace." : "No devices have the required permission. Check quick sharing in HomePlace."}</p>}
          </div>
          {sent && <p className="quick-share-success" role="status">{language === "ru" ? "Отправлено — получателю предложено принять." : "Sent — the recipient can accept it."}</p>}
          {error && <div className="setting-error" role="alert"><p>{error}</p><button type="button" disabled={targetsLoading || busy !== null} onClick={loadTargets}>{language === "ru" ? "Обновить устройства" : "Refresh devices"}</button></div>}
        </div>}
      </section>
    </main>
  );
}
