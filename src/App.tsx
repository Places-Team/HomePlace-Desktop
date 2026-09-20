import { invoke } from "@tauri-apps/api/core";
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

export function App() {
  const [platform, setPlatform] = useState<PlatformInfo>(() =>
    fallbackPlatformInfo(navigator.userAgent),
  );
  const [state, setState] = useState<ConnectionState>("not-configured");
  const [address, setAddress] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [server, setServer] = useState<VerifiedServer | null>(null);
  const [pairing, setPairing] = useState<PairingSession | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<PlatformInfo>("platform_info")
      .then((info) => {
        setPlatform(info);
        setDeviceName((current) => current || info.deviceName);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.platform = platform.platform;
  }, [platform.platform]);

  useEffect(() => {
    if (state !== "pairing" || !pairing || !server) return;

    const timer = window.setTimeout(async () => {
      try {
        const result = await invoke<PairingStatus>("poll_pairing", {
          serverId: server.serverId,
        });
        if (result.status === "approved") {
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

  const current = progressIndex(state);
  const busy = state === "verifying" || state === "requesting";

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

  return (
    <main className="desktop-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="titlebar" data-tauri-drag-region>
        <div className="brand-mark" aria-hidden>H</div>
        <div>
          <p className="eyebrow">HomePlace Link</p>
          <h1>Desktop</h1>
        </div>
        <span className="platform-pill">{platform.label}</span>
      </header>

      <section className="glass-card hero-card">
        <div className="hero-copy">
          <p className="eyebrow"><span className="status-dot" aria-hidden />Private by design</p>
          <h2>Connect {platform.label} to your HomePlace.</h2>
          <p className="lead">
            Verify your self-hosted server, request approval and keep the device identity in {platform.secureStorage}.
          </p>
        </div>

        <ol className="progress" aria-label="Connection progress">
          {steps.map((step, index) => (
            <li className={index <= current ? "active" : ""} key={step}>
              <span>{index + 1}</span>
              {step}
            </li>
          ))}
        </ol>

        <form className="connect-form" onSubmit={verify}>
          <label htmlFor="server-address">HomePlace server</label>
          <div className="field-row">
            <input
              id="server-address"
              type="url"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="https://home.example.net or http://192.168.1.20:3200"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-describedby="address-hint connection-message"
              aria-invalid={Boolean(error)}
              disabled={busy || state === "pairing" || state === "connected"}
              required
            />
            <button type="submit" disabled={!address.trim() || busy || state === "pairing" || state === "connected"}>
              {state === "verifying" ? "Verifying…" : server ? "Verify again" : "Continue"}
            </button>
          </div>
          <p className="hint" id="address-hint">
            Local HTTP stays inside your trusted network. Internet connections require HTTPS.
          </p>
        </form>

        <div id="connection-message" aria-live="polite">
          {error && <p className="connection-message error" role="alert">{error}</p>}
          {server && (
            <div className="connection-message verified">
              <div>
                <strong>{server.serverName}</strong>
                <span>Verified HomePlace server · Protocol v1</span>
              </div>
              {server.reducedSecurity && <span className="security-badge">Local HTTP</span>}
            </div>
          )}
        </div>

        {server && state !== "pairing" && state !== "connected" && (
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
                {state === "requesting" ? "Creating identity…" : "Request approval"}
              </button>
            </div>
            <p className="hint">The private P-256 key never leaves this device.</p>
          </form>
        )}

        {pairing && state === "pairing" && (
          <section className="approval-card" aria-label="Pairing approval">
            <p className="eyebrow">Confirm in HomePlace</p>
            <strong className="pairing-code">{pairing.code}</strong>
            <p>Open Devices in HomePlace, check this code and approve {deviceName}.</p>
            <span>Waiting securely · expires {new Date(pairing.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          </section>
        )}

        {state === "connected" && (
          <section className="approval-card connected-card" aria-label="Connected">
            <p className="eyebrow">Connected</p>
            <strong>{deviceName} is paired with {server?.serverName}.</strong>
            <p>The device credential is stored in {platform.secureStorage} and was never exposed to the interface.</p>
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
                ? "Glass materials focused menu bar experience."
                : platform.platform === "windows"
                  ? "Fluent surfaces familiar notification-area experience."
                  : "Desktop-neutral controls with compositor-aware materials."}
            </p>
          </div>
        </article>
        <article className="glass-card detail-card">
          <div className="detail-icon">⌁</div>
          <div>
            <h3>Credentials stay local</h3>
            <p>Device identity is stored in {platform.secureStorage}, never in interface state or logs.</p>
          </div>
        </article>
      </section>

      <footer>
        <span>Protocol v1</span>
        <span>Pairing · Presence · Secure storage</span>
      </footer>
    </main>
  );
}
