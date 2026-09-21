import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FormEvent, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { Icon, type IconName } from "./components/Icon";
import { copy, type Language } from "./lib/i18n";
import { fallbackPlatformInfo, type PlatformInfo } from "./lib/platform";

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

type ActiveTransferProgress = FileTransferProgress & {
  fileIndex: number;
  fileCount: number;
  targetName: string;
};

type PendingNativeShare = {
  files: string[];
  text?: string | null;
};

type Reminder = {
  id: string;
  title: string;
  at: string;
  repeat: string;
};

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
  { id: "devices", icon: "devices" },
  { id: "clipboard", icon: "clipboard" },
  { id: "transfers", icon: "transfer" },
  { id: "automations", icon: "automation" },
  { id: "productivity", icon: "calendar" },
  { id: "notifications", icon: "bell" },
  { id: "settings", icon: "settings" },
];

function errorMessage(error: unknown): string {
  return typeof error === "string" && error.trim()
    ? error
    : "The HomePlace request could not be completed.";
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
  const [remindersLoaded, setRemindersLoaded] = useState(true);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [reminderError, setReminderError] = useState<string | null>(null);
  const [addingReminder, setAddingReminder] = useState(false);
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderAt, setReminderAt] = useState(defaultReminderTime);
  const [reminderRepeat, setReminderRepeat] = useState("none");
  const [editingReminderId, setEditingReminderId] = useState<string | null>(null);
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
    if (!activeServerId) return;
    let cancelled = false;
    const range = visibleCalendarRange(calendarMonthOffset);
    invoke<CalendarSummary>("list_calendar_events", range)
      .then((result) => {
        if (cancelled) return;
        setCalendarEvents(result.events);
        setCalendarStatus(result.status);
      })
      .catch((reason) => {
        if (!cancelled) setCalendarError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setCalendarLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [activeServerId, calendarMonthOffset]);

  useEffect(() => {
    if (!activeServerId) return;
    let cancelled = false;
    invoke<Reminder[]>("list_reminders")
      .then((items) => {
        if (!cancelled) setReminders(items);
      })
      .catch((reason) => {
        if (!cancelled) setReminderError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setRemindersLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [activeServerId]);

  useEffect(() => {
    if (!activeServerId) return;
    let cancelled = false;
    invoke<AccountDevice[]>("list_account_devices")
      .then((items) => {
        if (!cancelled) {
          setAccountDevices(items);
          setAccountDevicesError(null);
        }
      })
      .catch((reason) => {
        if (!cancelled) setAccountDevicesError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setAccountDevicesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [activeServerId, lastHeartbeat]);

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
      { label: contextLabels.complete, icon: "check", disabled: reminderBusy, run: () => void resolveReminder("complete_reminder", reminder.id) },
      { label: contextLabels.edit, icon: "edit", disabled: reminderBusy, run: () => editReminder(reminder) },
      { label: contextLabels.snoozeTen, icon: "focus", disabled: reminderBusy, run: () => snoozeReminder(reminder, 10) },
      { label: contextLabels.snoozeHour, icon: "focus", disabled: reminderBusy, run: () => snoozeReminder(reminder, 60) },
      { label: contextLabels.tomorrow, icon: "calendar", disabled: reminderBusy, run: () => moveReminderToTomorrow(reminder) },
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
          className="reminder-item"
          key={reminder.id}
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
          <span>
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
          </span>
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

  const incomingOffer = offers.find((offer) => offer.id !== dismissedOfferId) ?? null;

  function accountDeviceIcon(platformName: string): IconName {
    const value = platformName.toLowerCase();
    if (value.includes("android")) return "android";
    if (value.includes("mac") || value.includes("ios")) return "apple";
    if (value.includes("win")) return "windows";
    if (value.includes("linux")) return "linux";
    return "devices";
  }

  return (
    <main className="desktop-shell">
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
            <button
              type="button"
              key={item.id}
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
          ))}
        </nav>

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
        <div>
          <p className="eyebrow">HomePlace Link · Desktop</p>
          <h1>{ui.nav[activeSection]}</h1>
        </div>
        <div className="titlebar-actions">
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
          <article className="glass-card feature-hero compact device-network-hero">
            <div className="feature-icon"><Icon name="devices" size={28} /></div>
            <div>
              <p className="eyebrow">HomePlace Link</p>
              <h2>{language === "ru" ? "Устройства вашего аккаунта" : "Your account devices"}</h2>
              <p className="lead">{language === "ru" ? "Все компьютеры и телефоны, связанные с текущим аккаунтом HomePlace. Подключение серверов теперь находится в настройках." : "Every computer and phone linked to this HomePlace account. Server connections are now managed in Settings."}</p>
            </div>
            <button type="button" className="subtle-action" onClick={() => setActiveSection("settings")}>
              <Icon name="settings" size={16} /> {language === "ru" ? "Подключения" : "Connections"}
            </button>
          </article>

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
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="status-dot" aria-hidden />
            {ui.devices.private}
          </p>
          <h2>{ui.devices.connect} {platform.label} {ui.devices.toHomePlace}</h2>
          <p className="lead">
            {ui.devices.lead} {platform.secureStorage}.
          </p>
        </div>

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
          {error && <div className="connection-message error">{error}</div>}
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

            <label className="startup-setting">
              <span>
              <b>{ui.devices.startup}</b>
              <small>{ui.devices.startupHint}</small>
              </span>
              <input
                type="checkbox"
                checked={startupEnabled}
                disabled={!startupLoaded || startupBusy}
                onChange={(event) => void updateStartup(event.target.checked)}
              />
            </label>
            {startupError && (
              <span className="setting-error" role="alert">
                {startupError}
              </span>
            )}
            <label className="startup-setting">
              <span>
              <b>{ui.devices.clipboard}</b>
                <small>{ui.devices.clipboardHint}</small>
              </span>
              <input
                type="checkbox"
                checked={clipboardSyncEnabled}
                disabled={!clipboardSyncLoaded || clipboardSyncBusy}
                onChange={(event) => void updateClipboardSync(event.target.checked)}
              />
            </label>
            {clipboardSyncError && (
              <span className="setting-error" role="alert">
                {clipboardSyncError}
              </span>
            )}
          </section>
        )}
      </section>
      )}

      {activeSection === "overview" && (
        <section className="section-stack" aria-label="Overview">
          <article className="glass-card welcome-card">
            <div>
              <p className="eyebrow">{ui.overview.eyebrow}</p>
              <h2>{lastHeartbeat ? ui.overview.connectedTitle : ui.overview.disconnectedTitle}</h2>
              <p className="lead">{ui.overview.lead}</p>
            </div>
            <button type="button" onClick={() => setActiveSection("devices")}>
              {profiles.length > 0 ? ui.overview.manage : ui.overview.connect}
            </button>
          </article>

          <section className="metric-grid" aria-label="Connection summary">
            <button type="button" className="glass-card metric-card" onClick={() => setActiveSection("devices")}>
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
            <button type="button" onClick={() => setActiveSection("automations")}>
              <span><Icon name="automation" size={18} /></span><b>{ui.overview.automation}</b><small>{ui.overview.actions}</small>
            </button>
          </section>
        </section>
      )}

      {activeSection === "clipboard" && (
        <section className="section-stack" aria-label="Clipboard">
          <article className="glass-card feature-hero">
            <div className="feature-icon"><Icon name="clipboard" size={27} /></div>
            <div>
              <p className="eyebrow">{ui.clipboard.eyebrow}</p>
              <h2>{ui.clipboard.title}</h2>
              <p className="lead">{ui.clipboard.lead}</p>
            </div>
            <label className="switch-control">
              <input
                type="checkbox"
                checked={clipboardSyncEnabled}
                disabled={!clipboardSyncLoaded || clipboardSyncBusy || !activeServerId}
                onChange={(event) => void updateClipboardSync(event.target.checked)}
              />
              <span>{clipboardSyncEnabled ? ui.clipboard.on : ui.clipboard.off}</span>
            </label>
          </article>
          {clipboardSyncError && <p className="setting-error">{clipboardSyncError}</p>}
          <section className="capability-grid">
            <article className="glass-card"><b>{ui.clipboard.textOnly}</b><p>{ui.clipboard.textHint}</p></article>
            <article className="glass-card"><b>{ui.clipboard.loop}</b><p>{ui.clipboard.loopHint}</p></article>
            <article className="glass-card"><b>{ui.clipboard.private}</b><p>{ui.clipboard.privateHint}</p></article>
          </section>
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
              <button
                type="button"
                className="clipboard-history-row"
                key={item.id}
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
            ))}
            {clipboardHistoryError && <p className="setting-error" role="alert">{clipboardHistoryError}</p>}
          </article>
        </section>
      )}

      {activeSection === "transfers" && (
        <section className="section-stack" aria-label="Transfers">
          <article className="glass-card feature-hero compact">
            <div className="feature-icon"><Icon name="transfer" size={27} /></div>
            <div>
              <p className="eyebrow">{ui.transfers.eyebrow}</p>
              <h2>{ui.transfers.title}</h2>
              <p className="lead">{ui.transfers.lead}</p>
            </div>
          </article>
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
          <ShareComposer language={language} />
        </section>
      )}

      {activeSection === "automations" && (
        <section className="section-stack" aria-label="Automations">
          <article className="glass-card feature-hero compact">
            <div className="feature-icon"><Icon name="automation" size={27} /></div><div><p className="eyebrow">{ui.automations.eyebrow}</p><h2>{ui.automations.title}</h2><p className="lead">{ui.automations.lead}</p></div><span className="preview-badge">{ui.automations.preview}</span>
          </article>
          <section className="automation-list">
            <article className="glass-card automation-row"><span>{ui.automations.android}</span><b>{ui.automations.magnet}</b><i>→</i><span>{ui.automations.torrent}</span><small>{ui.automations.planned}</small></article>
            <article className="glass-card automation-row"><span>{ui.automations.gaming}</span><b>{ui.automations.game}</b><i>→</i><span>{ui.automations.scene}</span><small>{ui.automations.planned}</small></article>
            <article className="glass-card automation-row"><span>{ui.automations.macbook}</span><b>{ui.automations.home}</b><i>→</i><span>{ui.automations.wake}</span><small>{ui.automations.planned}</small></article>
          </section>
          <button type="button" className="primary-action" disabled>{ui.automations.create}</button>
        </section>
      )}

      {activeSection === "productivity" && (
        <section className="section-stack productivity-page" aria-label="Productivity">
          <article className="glass-card productivity-hero">
            <div>
              <p className="eyebrow">{ui.productivity.eyebrow}</p>
              <h2>{ui.productivity.title}</h2>
              <p className="lead">{ui.productivity.lead}</p>
            </div>
            <span className="preview-badge">{ui.productivity.preview}</span>
          </article>

          <div className="productivity-layout">
            <article className="glass-card calendar-card">
              <div className="section-heading calendar-heading">
                <div>
                  <p className="eyebrow">{ui.productivity.calendar}</p>
                  <h3>{monthLabel}</h3>
                </div>
                <div className="calendar-actions" aria-label="Calendar navigation preview">
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
              <div className="reminder-column overdue-column">
                <b>{ui.productivity.overdue}</b>
                {reminderRows(overdueReminders)}
              </div>
              <div className="reminder-column">
                <b>{ui.productivity.today}</b>
                {reminderRows(todayReminders)}
              </div>
              <div className="reminder-column">
                <b>{ui.productivity.upcoming}</b>
                {reminderRows(upcomingReminders)}
              </div>
              <div className="reminder-column">
                <b>{ui.productivity.smartLists}</b>
                <div className="smart-list-row"><Icon name="home" size={14} />{ui.productivity.atHome} <small>{todayReminders.length}</small></div>
                <div className="smart-list-row"><Icon name="devices" size={14} />{ui.productivity.onDevice} <small>{reminders.length}</small></div>
              </div>
            </div>
          </article>

          <section className="productivity-features">
            <article className="glass-card"><span><Icon name="link" size={17} /></span><div><b>{ui.productivity.continueTitle}</b><p>{ui.productivity.continueHint}</p></div><small>{ui.productivity.planned}</small></article>
            <article className="glass-card"><span><Icon name="automation" size={17} /></span><div><b>{ui.productivity.contextTitle}</b><p>{ui.productivity.contextHint}</p></div><small>{ui.productivity.planned}</small></article>
            <article className="glass-card"><span><Icon name="bell" size={17} /></span><div><b>{ui.productivity.smartTitle}</b><p>{ui.productivity.smartHint}</p></div><small>{ui.productivity.planned}</small></article>
          </section>
        </section>
      )}

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
            <div className="settings-row"><span><b>{ui.notifications.telegram}</b><small>{ui.notifications.telegramHint}</small></span><em>{ui.notifications.server}</em></div>
            <div className="settings-row"><span><b>{ui.notifications.mobile}</b><small>{ui.notifications.mobileHint}</small></span><em>{ui.notifications.planned}</em></div>
            {systemNotificationsError && <p className="setting-error" role="alert">{systemNotificationsError}</p>}
          </article>
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
              <span>{language === "ru" ? "Основа тем" : "Theme foundation"}</span>
            </div>
            <div className="theme-choices" role="group" aria-label={language === "ru" ? "Тема оформления" : "Color theme"}>
              <button type="button" className={theme === "light" ? "active" : undefined} onClick={() => setTheme("light")}>
                <span className="theme-preview light-preview" aria-hidden><i /><i /><i /></span>
                <b>{language === "ru" ? "Светлая" : "Light"}</b>
                <small>{language === "ru" ? "Мягкий дневной контраст" : "Soft daylight contrast"}</small>
              </button>
              <button type="button" className={theme === "dark" ? "active" : undefined} onClick={() => setTheme("dark")}>
                <span className="theme-preview dark-preview" aria-hidden><i /><i /><i /></span>
                <b>{language === "ru" ? "Тёмная" : "Dark"}</b>
                <small>{language === "ru" ? "Глубокие спокойные поверхности" : "Deep, quiet surfaces"}</small>
              </button>
              <div className="theme-future">
                <Icon name="settings" size={18} />
                <span><b>{language === "ru" ? "Свои темы — дальше" : "Custom themes next"}</b><small>{language === "ru" ? "Палитра уже построена на заменяемых токенах." : "The palette already uses replaceable design tokens."}</small></span>
              </div>
            </div>
          </article>
          <article className="glass-card settings-panel">
            <div className="section-heading"><div><p className="eyebrow">{ui.settings.application}</p><h3>{ui.settings.general}</h3></div></div>
            <label className="settings-row"><span><b>{ui.settings.startup}</b><small>{ui.settings.startupHint}</small></span><input type="checkbox" checked={startupEnabled} disabled={!startupLoaded || startupBusy} onChange={(event) => void updateStartup(event.target.checked)} /></label>
            <label className="settings-row"><span><b>{ui.settings.clipboard}</b><small>{ui.settings.clipboardHint}</small></span><input type="checkbox" checked={clipboardSyncEnabled} disabled={!clipboardSyncLoaded || clipboardSyncBusy || !activeServerId} onChange={(event) => void updateClipboardSync(event.target.checked)} /></label>
            {(startupError || clipboardSyncError) && <p className="setting-error">{startupError ?? clipboardSyncError}</p>}
          </article>
          <article className="glass-card settings-panel">
            <div className="section-heading"><div><p className="eyebrow">{ui.settings.connection}</p><h3>{server?.serverName ?? ui.settings.server}</h3></div><span className={lastHeartbeat ? "status-chip online" : "status-chip"}>{lastHeartbeat ? ui.settings.online : ui.settings.offline}</span></div>
            <div className="settings-row static"><span><b>{ui.settings.address}</b><small>{server?.address ?? ui.settings.notPaired}</small></span></div>
            <div className="settings-row static"><span><b>{ui.settings.storage}</b><small>{platform.secureStorage} · {ui.settings.storageHint}</small></span></div>
            <div className="settings-actions"><button type="button" onClick={() => void reconnectNow()} disabled={!activeServerId || reconnecting}>{ui.settings.reconnect}</button><button type="button" onClick={beginAddServer}>{ui.devices.addServer}</button></div>
          </article>
          <article className="glass-card settings-panel muted-panel">
            <div className="section-heading"><div><p className="eyebrow">{ui.settings.about}</p><h3>HomePlace Link Desktop</h3></div><span>v0.1.0</span></div>
            <p>Protocol v1 · {ui.settings.companion} {platform.label}</p>
          </article>
        </section>
      )}

      {activeSection === "overview" && (
      <section className="details-grid">
        <article className="glass-card detail-card">
          <div className="detail-icon"><Icon name="devices" size={22} /></div>
          <div>
            <h3>{ui.details.platform}</h3>
            <p>
              {platform.platform === "macos"
                ? ui.details.mac
                : platform.platform === "windows"
                  ? ui.details.windows
                  : ui.details.linux}
            </p>
          </div>
        </article>
        <article className="glass-card detail-card">
          <div className="detail-icon"><Icon name="link" size={22} /></div>
          <div>
            <h3>{ui.details.trust}</h3>
            <p>{ui.details.trustHint}</p>
          </div>
        </article>
      </section>
      )}

      <footer>
        <span>{ui.details.protocol}</span>
        <span>{ui.details.secrets}</span>
      </footer>
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
        for (const [fileIndex, filePath] of files.entries()) {
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
          <small>{language === "ru" ? "До 20 файлов, каждый размером до 500 МиБ" : "Up to 20 files, each up to 500 MiB"}</small>
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
  const [language] = useState<Language>(() => {
    const saved = window.localStorage.getItem("homeplace-language");
    return saved === "en" || saved === "ru" ? saved : navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
  });
  const [targets, setTargets] = useState<ShareTarget[]>([]);
  const [payload, setPayload] = useState<QuickSharePayload | null>(null);
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [transferProgress, setTransferProgress] = useState<ActiveTransferProgress | null>(null);

  const loadTargets = useCallback(() => {
    setError(null);
    void invoke<ShareTarget[]>("list_share_targets")
      .then(setTargets)
      .catch((reason) => setError(errorMessage(reason)));
  }, []);

  const stageText = useCallback((value: string) => {
    setText(value);
    setSent(false);
    setTransferProgress(null);
    setError(null);
    const trimmed = value.trim();
    if (!trimmed) return setPayload(null);
    setPayload({ kind: /^https?:\/\/\S+$/i.test(trimmed) ? "url" : "text", value: trimmed, label: trimmed });
  }, []);

  const stageFiles = useCallback((paths: string[]) => {
    const unique = [...new Set(paths)].slice(0, 20);
    if (unique.length === 0) return;
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
  }, [loadTargets]);

  useEffect(() => {
    let cancelled = false;
    let stopOpen: (() => void) | undefined;
    let stopStage: (() => void) | undefined;
    let stopStageFiles: (() => void) | undefined;
    let stopNativeStage: (() => void) | undefined;
    let stopDragState: (() => void) | undefined;
    let stopDrop: (() => void) | undefined;
    const consumeNativeShare = () => {
      void invoke<PendingNativeShare | null>("take_pending_share").then((pending) => {
        if (cancelled || !pending) return;
        if (pending.files.length > 0) stageFiles(pending.files);
        else if (pending.text) stageText(pending.text);
      });
    };
    void listen<boolean>("quick-share-opened", ({ payload: shouldExpand }) => {
      if (!cancelled) {
        setExpanded(shouldExpand);
        loadTargets();
      }
    }).then((unlisten) => {
      if (cancelled) unlisten(); else stopOpen = unlisten;
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
        if (active) setExpanded(false);
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
    };
  }, [loadTargets, stageFiles, stageText]);

  useEffect(() => {
    void invoke("set_quick_share_expanded", { expanded }).catch((reason) => {
      setError(errorMessage(reason));
    });
  }, [expanded]);

  useEffect(() => {
    void invoke("set_quick_share_pinned", { pinned: payload !== null }).catch((reason) => {
      setError(errorMessage(reason));
    });
  }, [payload]);

  const dismissShelf = useCallback(() => {
    setPayload(null);
    setText("");
    setExpanded(false);
    setSent(false);
    setTransferProgress(null);
    setError(null);
    void invoke("set_quick_share_pinned", { pinned: false }).finally(() => {
      void getCurrentWindow().hide();
    });
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
    setBusy(target.id);
    setError(null);
    setSent(false);
    setTransferProgress(null);
    try {
      if (payload.kind === "files") {
        for (const [fileIndex, filePath] of payload.paths.entries()) {
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
      loadTargets();
      await invoke("set_quick_share_pinned", { pinned: false });
      window.setTimeout(() => {
        setExpanded(false);
        void getCurrentWindow().hide();
      }, 1400);
    } catch (reason) {
      setError(errorMessage(reason));
      setTransferProgress(null);
    } finally {
      setBusy(null);
    }
  }

  const compatible = targets.filter((target) => !payload
    || (payload.kind === "files" && target.supportsFile)
    || (payload.kind === "url" && target.supportsUrl)
    || (payload.kind === "text" && target.supportsText));

  return (
    <main
      className={`tray-share-root${expanded ? " expanded" : ""}${dragging ? " dragging" : ""}${busy ? " sending" : ""}${sent ? " sent" : ""}`}
      onMouseEnter={() => {
        setExpanded(true);
        void invoke("set_quick_share_pointer_inside", { inside: true });
      }}
      onMouseLeave={() => {
        if (!busy && !payload && !sent) setExpanded(false);
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
            <Icon name="transfer" size={22} />
          </button>
        )}
        {expanded && <div className="tray-share-titlebar">
          <span><Icon name="transfer" size={17} /></span>
          <div><b>{language === "ru" ? "Быстрая отправка" : "Quick share"}</b><small>HomePlace Link</small></div>
          <button type="button" disabled={busy !== null} onClick={dismissShelf}>×</button>
        </div>}
        {expanded && <div className="quick-share-panel">
          <div className="quick-share-copy">
            <b>{language === "ru" ? "Перетащите файл из Finder" : "Drop a file from Finder"}</b>
            <small>{language === "ru" ? "Или вставьте текст или ссылку, затем выберите устройство." : "Or paste text or a link, then choose a device."}</small>
          </div>
          {payload?.kind === "files" ? (
            <div className="quick-share-payload">
              <Icon name="transfer" size={17} />
              <span><b>{payload.label}</b><small>{language === "ru" ? `${payload.paths.length} файл(ов), до 500 МиБ каждый` : `${payload.paths.length} file(s), up to 500 MiB each`}</small></span>
              <button type="button" disabled={busy !== null} onClick={dismissShelf}>×</button>
            </div>
          ) : (
            <textarea
              value={text}
              maxLength={8000}
              rows={3}
              placeholder={language === "ru" ? "Вставьте текст или ссылку" : "Paste text or a link"}
              onChange={(event) => stageText(event.target.value)}
            />
          )}
          {transferProgress && <TransferProgressPanel progress={transferProgress} language={language} />}
          <div className="quick-share-targets">
            {compatible.map((target) => (
              <button type="button" key={target.id} disabled={!payload || busy !== null} onClick={() => void send(target)}>
                <span className={target.online ? "online" : undefined}><Icon name="devices" size={17} /></span>
                <span><b>{target.name}</b><small>{target.ownerName} · {target.platform}</small></span>
                <em>{busy === target.id && transferProgress ? <TransferProgressRing progress={transferProgress} compact /> : busy === target.id ? "…" : "→"}</em>
              </button>
            ))}
            {compatible.length === 0 && <p>{language === "ru" ? "Нет доступных устройств. Проверьте разрешение быстрой отправки в HomePlace." : "No available devices. Check quick-sharing permission in HomePlace."}</p>}
          </div>
          {sent && <p className="quick-share-success">{language === "ru" ? "Отправлено — ожидается подтверждение." : "Sent — waiting for approval."}</p>}
          {error && <p className="setting-error" role="alert">{error}</p>}
        </div>}
      </section>
    </main>
  );
}
