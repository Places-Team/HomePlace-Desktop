import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FormEvent, useEffect, useState } from "react";
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

type AppSection =
  | "overview"
  | "devices"
  | "clipboard"
  | "transfers"
  | "automations"
  | "productivity"
  | "notifications"
  | "settings";

const steps = ["Server", "Verify", "Approve", "Connected"];

const navigation: Array<{
  id: AppSection;
  label: string;
  icon: string;
}> = [
  { id: "overview", label: "Overview", icon: "⌂" },
  { id: "devices", label: "Devices", icon: "◇" },
  { id: "clipboard", label: "Clipboard", icon: "▣" },
  { id: "transfers", label: "Transfers", icon: "⇄" },
  { id: "automations", label: "Automations", icon: "⌁" },
  { id: "productivity", label: "Productivity", icon: "□" },
  { id: "notifications", label: "Notifications", icon: "◌" },
  { id: "settings", label: "Settings", icon: "⚙" },
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

export function App() {
  const [activeSection, setActiveSection] = useState<AppSection>("overview");
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
  const today = new Date();
  const monthLabel = today.toLocaleDateString("en", {
    month: "long",
    year: "numeric",
  });
  const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const calendarDays = Array.from({ length: 42 }, (_, index) => {
    const value = new Date(
      today.getFullYear(),
      today.getMonth(),
      index - mondayOffset + 1,
    );
    return {
      key: value.toISOString(),
      day: value.getDate(),
      currentMonth: value.getMonth() === today.getMonth(),
      isToday: value.toDateString() === today.toDateString(),
    };
  });

  function clearConnectionHealth() {
    setLastHeartbeat(null);
    setHeartbeatError(null);
    setPendingEvents(0);
    setDeliveredNotifications(0);
    setNotificationFailures(0);
    setOffers([]);
    setOfferError(null);
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

  return (
    <main className="desktop-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <aside className="app-sidebar" aria-label="Main navigation">
        <div className="sidebar-brand" data-tauri-drag-region>
          <div className="brand-mark" aria-hidden>
            H
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
              <span aria-hidden>{item.icon}</span>
              <span className="nav-label">{item.label}</span>
              {item.id === "notifications" && notificationFailures > 0 && (
                <small>{notificationFailures}</small>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-status">
          <span className={lastHeartbeat ? "online" : undefined} aria-hidden />
          <div>
            <b>{server?.serverName ?? "No server"}</b>
            <small>{lastHeartbeat ? "Connected" : "Waiting for connection"}</small>
          </div>
        </div>
      </aside>

      <div className="app-content">

      <header className="titlebar" data-tauri-drag-region>
        <div>
          <p className="eyebrow">HomePlace Link · Desktop</p>
          <h1>{navigation.find((item) => item.id === activeSection)?.label}</h1>
        </div>
        <span className="platform-pill">{platform.label}</span>
      </header>

      {activeSection === "devices" && (
      <section className="glass-card hero-card">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="status-dot" aria-hidden />
            Private by design
          </p>
          <h2>Connect {platform.label} to your HomePlace.</h2>
          <p className="lead">
            Pair with multiple self-hosted servers, switch safely and keep every
            device identity in {platform.secureStorage}.
          </p>
        </div>

        {profiles.length > 0 && (
          <section className="profile-switcher" aria-label="Paired servers">
            <div className="profile-heading">
              <div>
                <p className="eyebrow">Paired servers</p>
                <strong>{profiles.length} available</strong>
              </div>
              {isAddingServer ? (
                <button type="button" onClick={() => void cancelSetup()}>
                  Cancel setup
                </button>
              ) : (
                <button type="button" onClick={beginAddServer} disabled={busy}>
                  Add server
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
          {steps.map((step, index) => (
            <li className={index <= current ? "active" : ""} key={step}>
              <span>{index + 1}</span>
              {step}
            </li>
          ))}
        </ol>

        {!profilesLoaded && (
          <p className="loading-profile" aria-live="polite">
            Loading secure profiles…
          </p>
        )}

        {profilesLoaded && state !== "connected" && (
          <form className="connect-form" onSubmit={verify}>
            <label htmlFor="server-address">HomePlace server</label>
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
                {state === "verifying" ? "Verifying…" : "Verify server"}
              </button>
            </div>
            <p className="hint" id="address-hint">
              HTTPS is recommended. Local private-network addresses may use HTTP.
            </p>
          </form>
        )}

        <div id="connection-message" aria-live="polite">
          {error && <div className="connection-message error">{error}</div>}
          {server && state !== "not-configured" && state !== "connected" && (
            <div className="connection-message">
              <div>
                <strong>{server.serverName}</strong>
                <span>Compatible with HomePlace Link v1</span>
              </div>
              {server.reducedSecurity && (
                <span className="security-badge">Local HTTP</span>
              )}
            </div>
          )}
        </div>

        {server && state === "verified" && (
          <form className="pairing-form" onSubmit={requestPairing}>
            <label htmlFor="device-name">Device name</label>
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
                Request approval
              </button>
            </div>
            <p className="hint">The private P-256 key never leaves this device.</p>
          </form>
        )}

        {pairing && state === "pairing" && (
          <section className="approval-card" aria-label="Pairing approval">
            <p className="eyebrow">Confirm in HomePlace</p>
            <strong className="pairing-code">{pairing.code}</strong>
            <p>
              Open Devices in HomePlace, check this code and approve {deviceName}.
            </p>
            <span>
              Waiting securely · expires{" "}
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
              Cancel request
            </button>
          </section>
        )}

        {state === "connected" && (
          <section className="approval-card connected-card" aria-label="Connected">
            <p className="eyebrow">Connected</p>
            <strong>
              {deviceName} paired with {server?.serverName}.
            </strong>
            <p className="server-address">{server?.address}</p>
            <p>
              The device credential is stored in {platform.secureStorage}.
              HomePlace stays active in the system tray and reports presence in
              the background.
            </p>
            {heartbeatError ? (
              <span className="heartbeat-error">{heartbeatError}</span>
            ) : (
              <span>
                {lastHeartbeat
                  ? `Online · checked ${lastHeartbeat.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`
                  : "Connecting…"}
                {deliveredNotifications > 0
                  ? ` · ${deliveredNotifications} notification${
                      deliveredNotifications === 1 ? "" : "s"
                    } delivered`
                  : ""}
                {notificationFailures > 0
                  ? ` · ${notificationFailures} notification${
                      notificationFailures === 1 ? "" : "s"
                    } need attention`
                  : ""}
                {pendingEvents > 0
                  ? ` · ${pendingEvents} pending event${pendingEvents === 1 ? "" : "s"}`
                  : ""}
              </span>
            )}

            {offers.length > 0 && (
              <section className="pending-offers" aria-label="Pending shares">
                <div className="offer-heading">
                  <b>Waiting for approval</b>
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
                          ? "Open link"
                          : offer.kind === "file"
                            ? "Save file"
                            : "Copy text"}
                      </b>
                      <small>
                        From {offer.sourceName} ·{" "}
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
                      {offerBusy === offer.id ? "Working…" : "Accept"}
                    </button>
                    <button
                      type="button"
                      disabled={offerBusy !== null}
                      onClick={() => void handleOffer(offer, "decline")}
                    >
                      Decline
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
                {reconnecting ? "Reconnecting…" : "Reconnect now"}
              </button>
              <button
                type="button"
                onClick={() => void disconnect(false)}
                disabled={profileBusy}
              >
                Forget locally
              </button>
              <button
                type="button"
                onClick={() => void disconnect(true)}
                disabled={profileBusy}
              >
                Disconnect
              </button>
            </div>

            <label className="startup-setting">
              <span>
                <b>Start at login</b>
                <small>Launch hidden and keep HomePlace available in the tray.</small>
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
                <b>Seamless clipboard sync</b>
                <small>
                  Automatically sync copied text with your other paired devices. Clipboard contents stay inside your HomePlace account.
                </small>
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
              <p className="eyebrow">Your personal device network</p>
              <h2>{lastHeartbeat ? "Everything is connected." : "Connect your devices."}</h2>
              <p className="lead">
                Move text, files, links and actions between your computers,
                phones and self-hosted services from one private place.
              </p>
            </div>
            <button type="button" onClick={() => setActiveSection("devices")}>
              {profiles.length > 0 ? "Manage devices" : "Connect a server"}
            </button>
          </article>

          <section className="metric-grid" aria-label="Connection summary">
            <button type="button" className="glass-card metric-card" onClick={() => setActiveSection("devices")}>
              <span>◇</span>
              <strong>{profiles.length}</strong>
              <small>Paired server{profiles.length === 1 ? "" : "s"}</small>
            </button>
            <button type="button" className="glass-card metric-card" onClick={() => setActiveSection("transfers")}>
              <span>⇄</span>
              <strong>{pendingEvents}</strong>
              <small>Pending transfer{pendingEvents === 1 ? "" : "s"}</small>
            </button>
            <button type="button" className="glass-card metric-card" onClick={() => setActiveSection("notifications")}>
              <span>◌</span>
              <strong>{deliveredNotifications}</strong>
              <small>Notifications delivered</small>
            </button>
          </section>

          <section className="quick-actions" aria-label="Quick actions">
            <button type="button" onClick={() => setActiveSection("clipboard")}>
              <span>▣</span><b>Clipboard</b><small>Sync copied text</small>
            </button>
            <button type="button" onClick={() => setActiveSection("transfers")}>
              <span>⇄</span><b>Send a file</b><small>Secure device transfer</small>
            </button>
            <button type="button" onClick={() => setActiveSection("automations")}>
              <span>⌁</span><b>Automation</b><small>Connect apps and actions</small>
            </button>
          </section>
        </section>
      )}

      {activeSection === "clipboard" && (
        <section className="section-stack" aria-label="Clipboard">
          <article className="glass-card feature-hero">
            <div className="feature-icon">▣</div>
            <div>
              <p className="eyebrow">Seamless text handoff</p>
              <h2>Copy here. Paste there.</h2>
              <p className="lead">
                Newly copied text is relayed to your other paired devices.
                Existing clipboard contents are never uploaded when you enable it.
              </p>
            </div>
            <label className="switch-control">
              <input
                type="checkbox"
                checked={clipboardSyncEnabled}
                disabled={!clipboardSyncLoaded || clipboardSyncBusy || !activeServerId}
                onChange={(event) => void updateClipboardSync(event.target.checked)}
              />
              <span>{clipboardSyncEnabled ? "On" : "Off"}</span>
            </label>
          </article>
          {clipboardSyncError && <p className="setting-error">{clipboardSyncError}</p>}
          <section className="capability-grid">
            <article className="glass-card"><b>Text only</b><p>Formatting, whitespace and line breaks are preserved up to 8,000 characters.</p></article>
            <article className="glass-card"><b>Loop protection</b><p>Content fingerprints stop copied text from bouncing endlessly between devices.</p></article>
            <article className="glass-card"><b>Private relay</b><p>Only devices paired to the same HomePlace account can receive an update.</p></article>
          </section>
        </section>
      )}

      {activeSection === "transfers" && (
        <section className="section-stack" aria-label="Transfers">
          <article className="glass-card feature-hero compact">
            <div className="feature-icon">⇄</div>
            <div>
              <p className="eyebrow">Cross-device handoff</p>
              <h2>Transfers</h2>
              <p className="lead">Receive text, links and verified files without exposing their contents to the interface.</p>
            </div>
          </article>
          <article className="glass-card transfer-list">
            <div className="section-heading"><div><p className="eyebrow">Inbox</p><h3>Waiting for approval</h3></div><span>{offers.length}</span></div>
            {offers.length === 0 ? (
              <div className="empty-state"><span>✓</span><b>Nothing waiting</b><p>Incoming links and files that require your approval will appear here.</p></div>
            ) : offers.map((offer) => (
              <div className="transfer-row" key={offer.id}>
                <span>{offer.kind === "url" ? "↗" : offer.kind === "file" ? "↓" : "T"}</span>
                <div><b>{offer.kind === "url" ? "Open link" : offer.kind === "file" ? "Save file" : "Copy text"}</b><small>From {offer.sourceName}</small></div>
                <button type="button" disabled={offerBusy !== null} onClick={() => void handleOffer(offer, offer.kind === "url" ? "open" : offer.kind === "file" ? "save" : "copy")}>Accept</button>
                <button type="button" disabled={offerBusy !== null} onClick={() => void handleOffer(offer, "decline")}>Decline</button>
              </div>
            ))}
          </article>
          <article className="glass-card planned-action"><span>＋</span><div><b>Send from this computer</b><p>Device picker, drag-and-drop files and link sending are the next transfer milestone.</p></div><small>Coming next</small></article>
        </section>
      )}

      {activeSection === "automations" && (
        <section className="section-stack" aria-label="Automations">
          <article className="glass-card feature-hero compact">
            <div className="feature-icon">⌁</div><div><p className="eyebrow">Link rules</p><h2>Automations</h2><p className="lead">Create private flows between devices, Home Assistant and self-hosted services.</p></div><span className="preview-badge">Preview</span>
          </article>
          <section className="automation-list">
            <article className="glass-card automation-row"><span>Android</span><b>Magnet link received</b><i>→</i><span>qBittorrent</span><small>Planned</small></article>
            <article className="glass-card automation-row"><span>Gaming PC</span><b>Game launched</b><i>→</i><span>Home Assistant scene</span><small>Planned</small></article>
            <article className="glass-card automation-row"><span>MacBook</span><b>Arrives home</b><i>→</i><span>Wake work PC</span><small>Planned</small></article>
          </section>
          <button type="button" className="primary-action" disabled>Create automation</button>
        </section>
      )}

      {activeSection === "productivity" && (
        <section className="section-stack productivity-page" aria-label="Productivity">
          <article className="glass-card productivity-hero">
            <div>
              <p className="eyebrow">Your day across every device</p>
              <h2>One place to plan and continue.</h2>
              <p className="lead">
                Calendar, reminders, focus sessions and cross-device handoff
                will stay in sync through your own HomePlace server.
              </p>
            </div>
            <span className="preview-badge">Workspace preview</span>
          </article>

          <div className="productivity-layout">
            <article className="glass-card calendar-card">
              <div className="section-heading calendar-heading">
                <div>
                  <p className="eyebrow">Calendar</p>
                  <h3>{monthLabel}</h3>
                </div>
                <div className="calendar-actions" aria-label="Calendar navigation preview">
                  <button type="button" disabled aria-label="Previous month">‹</button>
                  <button type="button" disabled>Today</button>
                  <button type="button" disabled aria-label="Next month">›</button>
                </div>
              </div>
              <div className="calendar-weekdays" aria-hidden>
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <span key={day}>{day}</span>)}
              </div>
              <div className="calendar-grid" aria-label={monthLabel}>
                {calendarDays.map((day) => (
                  <button
                    type="button"
                    key={day.key}
                    className={`${day.currentMonth ? "" : "outside"} ${day.isToday ? "today" : ""}`}
                    disabled
                    aria-current={day.isToday ? "date" : undefined}
                  >
                    {day.day}
                  </button>
                ))}
              </div>
              <div className="calendar-source-row">
                <span><i className="source-dot personal" />Personal</span>
                <span><i className="source-dot home" />HomePlace</span>
                <small>CalDAV and external calendars planned</small>
              </div>
            </article>

            <aside className="productivity-side">
              <article className="glass-card agenda-card">
                <div className="section-heading">
                  <div><p className="eyebrow">Today</p><h3>Agenda</h3></div>
                  <span>{today.getDate()}</span>
                </div>
                <div className="agenda-empty">
                  <span>□</span>
                  <b>Your day is clear</b>
                  <p>Calendar events will appear after a source is connected.</p>
                </div>
                <button type="button" className="subtle-action" disabled>＋ Add event</button>
              </article>

              <article className="glass-card focus-card">
                <div>
                  <p className="eyebrow">Focus</p>
                  <h3>25:00</h3>
                  <small>Silence HomePlace notifications on every device.</small>
                </div>
                <button type="button" disabled>Start</button>
              </article>
            </aside>
          </div>

          <article className="glass-card reminders-card">
            <div className="section-heading">
              <div><p className="eyebrow">Reminders</p><h3>Tasks that follow you</h3></div>
              <button type="button" className="subtle-action" disabled>＋ New reminder</button>
            </div>
            <div className="reminder-grid">
              <div className="reminder-column">
                <b>Today</b>
                <div className="reminder-preview"><span />Review HomePlace device alerts<small>Notification on phone and desktop</small></div>
              </div>
              <div className="reminder-column">
                <b>Upcoming</b>
                <div className="reminder-preview"><span />Plan weekly server maintenance<small>HomePlace calendar</small></div>
              </div>
              <div className="reminder-column">
                <b>Smart lists</b>
                <div className="smart-list-row"><span>⌂</span>At home <small>0</small></div>
                <div className="smart-list-row"><span>◇</span>On this device <small>0</small></div>
              </div>
            </div>
          </article>

          <section className="productivity-features">
            <article className="glass-card"><span>↗</span><div><b>Continue on another device</b><p>Open the active document, link or app on a paired computer.</p></div><small>Planned</small></article>
            <article className="glass-card"><span>⌁</span><div><b>Context automations</b><p>Start Home Assistant scenes when focus or calendar states change.</p></div><small>Planned</small></article>
            <article className="glass-card"><span>◌</span><div><b>Smart reminders</b><p>Notify the right device based on presence, battery and network.</p></div><small>Planned</small></article>
          </section>
        </section>
      )}

      {activeSection === "notifications" && (
        <section className="section-stack" aria-label="Notifications">
          <section className="metric-grid notification-metrics">
            <article className="glass-card metric-card"><span>✓</span><strong>{deliveredNotifications}</strong><small>Delivered</small></article>
            <article className="glass-card metric-card"><span>!</span><strong>{notificationFailures}</strong><small>Need attention</small></article>
            <article className="glass-card metric-card"><span>◌</span><strong>{lastHeartbeat ? "Live" : "—"}</strong><small>Device channel</small></article>
          </section>
          <article className="glass-card settings-panel">
            <div className="section-heading"><div><p className="eyebrow">Delivery</p><h3>Notification routes</h3></div></div>
            <div className="settings-row"><span><b>Desktop notifications</b><small>Show HomePlace events through the native notification centre.</small></span><em>Enabled</em></div>
            <div className="settings-row"><span><b>Telegram health alerts</b><small>HomePlace monitors configured bots and reports availability failures.</small></span><em>Managed on server</em></div>
            <div className="settings-row"><span><b>Mobile approval requests</b><small>Approve sensitive desktop actions from your paired phone.</small></span><em>Planned</em></div>
          </article>
        </section>
      )}

      {activeSection === "settings" && (
        <section className="section-stack" aria-label="Settings">
          <article className="glass-card settings-panel">
            <div className="section-heading"><div><p className="eyebrow">Application</p><h3>General</h3></div></div>
            <label className="settings-row"><span><b>Start at login</b><small>Launch hidden and keep HomePlace available in the system tray.</small></span><input type="checkbox" checked={startupEnabled} disabled={!startupLoaded || startupBusy} onChange={(event) => void updateStartup(event.target.checked)} /></label>
            <label className="settings-row"><span><b>Seamless clipboard sync</b><small>Automatically relay newly copied text between paired devices.</small></span><input type="checkbox" checked={clipboardSyncEnabled} disabled={!clipboardSyncLoaded || clipboardSyncBusy || !activeServerId} onChange={(event) => void updateClipboardSync(event.target.checked)} /></label>
            {(startupError || clipboardSyncError) && <p className="setting-error">{startupError ?? clipboardSyncError}</p>}
          </article>
          <article className="glass-card settings-panel">
            <div className="section-heading"><div><p className="eyebrow">Connection</p><h3>{server?.serverName ?? "HomePlace server"}</h3></div><span className={lastHeartbeat ? "status-chip online" : "status-chip"}>{lastHeartbeat ? "Online" : "Offline"}</span></div>
            <div className="settings-row static"><span><b>Server address</b><small>{server?.address ?? "No server paired"}</small></span></div>
            <div className="settings-row static"><span><b>Credential storage</b><small>{platform.secureStorage} · separate identity for every server</small></span></div>
            <div className="settings-actions"><button type="button" onClick={() => void reconnectNow()} disabled={!activeServerId || reconnecting}>Reconnect</button><button type="button" onClick={() => setActiveSection("devices")}>Manage servers</button></div>
          </article>
          <article className="glass-card settings-panel muted-panel">
            <div className="section-heading"><div><p className="eyebrow">About</p><h3>HomePlace Link Desktop</h3></div><span>v0.1.0</span></div>
            <p>Protocol v1 · Platform-native companion for {platform.label}</p>
          </article>
        </section>
      )}

      {activeSection === "overview" && (
      <section className="details-grid">
        <article className="glass-card detail-card">
          <div className="detail-icon">◇</div>
          <div>
            <h3>Platform-native</h3>
            <p>
              {platform.platform === "macos"
                ? "Menu bar presence and glass materials designed for macOS."
                : platform.platform === "windows"
                  ? "Notification-area presence and Fluent-compatible surfaces."
                  : "Desktop-neutral tray controls with compositor-aware styling."}
            </p>
          </div>
        </article>
        <article className="glass-card detail-card">
          <div className="detail-icon">⌁</div>
          <div>
            <h3>Separate trust per server</h3>
            <p>
              Every HomePlace keeps its own key, credential and device identity
              in {platform.secureStorage}.
            </p>
          </div>
        </article>
      </section>
      )}

      <footer>
        <span>HomePlace Link protocol v1</span>
        <span>Secrets stay in platform secure storage</span>
      </footer>
      </div>
    </main>
  );
}
