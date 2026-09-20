import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FormEvent, useEffect, useState } from "react";
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
};

type StartupStatus = {
  enabled: boolean;
};

type ClipboardSyncStatus = {
  enabled: boolean;
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
  const [activeSection, setActiveSection] = useState<AppSection>("overview");
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
  const [reconnecting, setReconnecting] = useState(false);
  const [startupEnabled, setStartupEnabled] = useState(false);
  const [startupLoaded, setStartupLoaded] = useState(false);
  const [startupBusy, setStartupBusy] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [clipboardSyncEnabled, setClipboardSyncEnabled] = useState(false);
  const [clipboardSyncLoaded, setClipboardSyncLoaded] = useState(false);
  const [clipboardSyncBusy, setClipboardSyncBusy] = useState(false);
  const [clipboardSyncError, setClipboardSyncError] = useState<string | null>(null);
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
    if (!activeServerId) return;
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
  const overdueReminders = reminders.filter((reminder) => new Date(reminder.at) < startOfToday);
  const todayReminders = reminders.filter((reminder) => {
    const at = new Date(reminder.at);
    return at >= startOfToday && at < startOfTomorrow;
  });
  const upcomingReminders = reminders.filter((reminder) => new Date(reminder.at) >= startOfTomorrow);

  function clearConnectionHealth() {
    setLastHeartbeat(null);
    setHeartbeatError(null);
    setPendingEvents(0);
    setDeliveredNotifications(0);
    setNotificationFailures(0);
    setOffers([]);
    setOfferError(null);
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
    if (!window.confirm(message)) return;

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
        <div className="reminder-item" key={reminder.id}>
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
              {reminder.repeat !== "none" ? ` · ${reminder.repeat}` : ""}
            </small>
          </span>
          <button
            type="button"
            className="reminder-edit"
            aria-label={`${ui.productivity.edit}: ${reminder.title}`}
            title={ui.productivity.edit}
            disabled={reminderBusy}
            onClick={() => editReminder(reminder)}
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

  return (
    <main className="desktop-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <aside className="app-sidebar" aria-label="Main navigation">
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
              onClick={() => setActiveSection(item.id)}
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
          <div className="language-switcher" aria-label={ui.language}>
            <button type="button" className={language === "ru" ? "active" : undefined} onClick={() => setLanguage("ru")}>RU</button>
            <button type="button" className={language === "en" ? "active" : undefined} onClick={() => setLanguage("en")}>EN</button>
          </div>
          <span className="platform-pill">{platform.label}</span>
        </div>
      </header>

      {activeSection === "devices" && (
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
                  <article key={offer.id} className="offer-row">
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
              <div className="transfer-row" key={offer.id}>
                <span>{offer.kind === "url" ? "↗" : offer.kind === "file" ? "↓" : "T"}</span>
                <div><b>{offer.kind === "url" ? ui.transfers.open : offer.kind === "file" ? ui.transfers.save : ui.transfers.copy}</b><small>{ui.transfers.from} {offer.sourceName}</small></div>
                <button type="button" disabled={offerBusy !== null} onClick={() => void handleOffer(offer, offer.kind === "url" ? "open" : offer.kind === "file" ? "save" : "copy")}>{ui.transfers.accept}</button>
                <button type="button" disabled={offerBusy !== null} onClick={() => void handleOffer(offer, "decline")}>{ui.transfers.decline}</button>
              </div>
            ))}
          </article>
          <article className="glass-card planned-action"><span><Icon name="plus" size={22} /></span><div><b>{ui.transfers.send}</b><p>{ui.transfers.sendHint}</p></div><small>{ui.transfers.next}</small></article>
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
                      <div className="agenda-item" key={event.id}>
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
                  <select value={reminderRepeat} onChange={(event) => setReminderRepeat(event.target.value)}>
                    <option value="none">{ui.productivity.once}</option>
                    <option value="hourly">{ui.productivity.hourly}</option>
                    <option value="daily">{ui.productivity.daily}</option>
                    <option value="weekly">{ui.productivity.weekly}</option>
                    <option value="monthly">{ui.productivity.monthly}</option>
                    <option value="yearly">{ui.productivity.yearly}</option>
                  </select>
                </label>
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
            <div className="settings-row"><span><b>{ui.notifications.desktop}</b><small>{ui.notifications.desktopHint}</small></span><em>{ui.notifications.enabled}</em></div>
            <div className="settings-row"><span><b>{ui.notifications.telegram}</b><small>{ui.notifications.telegramHint}</small></span><em>{ui.notifications.server}</em></div>
            <div className="settings-row"><span><b>{ui.notifications.mobile}</b><small>{ui.notifications.mobileHint}</small></span><em>{ui.notifications.planned}</em></div>
          </article>
        </section>
      )}

      {activeSection === "settings" && (
        <section className="section-stack" aria-label="Settings">
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
            <div className="settings-actions"><button type="button" onClick={() => void reconnectNow()} disabled={!activeServerId || reconnecting}>{ui.settings.reconnect}</button><button type="button" onClick={() => setActiveSection("devices")}>{ui.settings.manage}</button></div>
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
    </main>
  );
}
