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
    }
  | { status: "failed"; message: string };

type StartupStatus = {
  enabled: boolean;
};

const steps = ["Server", "Verify", "Approve", "Connected"];

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
  const [reconnecting, setReconnecting] = useState(false);
  const [startupEnabled, setStartupEnabled] = useState(false);
  const [startupLoaded, setStartupLoaded] = useState(false);
  const [startupBusy, setStartupBusy] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);

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

  function clearConnectionHealth() {
    setLastHeartbeat(null);
    setHeartbeatError(null);
    setPendingEvents(0);
    setDeliveredNotifications(0);
    setNotificationFailures(0);
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

  return (
    <main className="desktop-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="titlebar" data-tauri-drag-region>
        <div className="brand-mark" aria-hidden>
          H
        </div>
        <div>
          <p className="eyebrow">HomePlace Link</p>
          <h1>Desktop</h1>
        </div>
        <span className="platform-pill">{platform.label}</span>
      </header>

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
          </section>
        )}
      </section>

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

      <footer>
        <span>HomePlace Link protocol v1</span>
        <span>Secrets stay in platform secure storage</span>
      </footer>
    </main>
  );
}
