import { invoke } from "@tauri-apps/api/core";
import { FormEvent, useEffect, useState } from "react";
import { fallbackPlatformInfo, type PlatformInfo } from "./lib/platform";

type ConnectionState = "not-configured" | "verifying" | "pairing" | "connected";

type VerifiedServer = {
  address: string;
  serverId: string;
  serverName: string;
  realtime: boolean;
  reducedSecurity: boolean;
};

const steps: { id: ConnectionState; label: string }[] = [
  { id: "not-configured", label: "Server" },
  { id: "verifying", label: "Verify" },
  { id: "pairing", label: "Approve" },
  { id: "connected", label: "Connected" },
];

function errorMessage(error: unknown): string {
  return typeof error === "string" && error.trim()
    ? error
    : "The HomePlace server could not be verified.";
}

export function App() {
  const [platform, setPlatform] = useState<PlatformInfo>(() =>
    fallbackPlatformInfo(navigator.userAgent),
  );
  const [state, setState] = useState<ConnectionState>("not-configured");
  const [address, setAddress] = useState("");
  const [server, setServer] = useState<VerifiedServer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<PlatformInfo>("platform_info").then(setPlatform).catch(() => undefined);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.platform = platform.platform;
  }, [platform.platform]);

  const current = steps.findIndex((step) => step.id === state);

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!address.trim() || state === "verifying") return;

    setState("verifying");
    setServer(null);
    setError(null);

    try {
      const verified = await invoke<VerifiedServer>("verify_server", { address });
      setServer(verified);
      setAddress(verified.address);
      setState("pairing");
    } catch (reason) {
      setError(errorMessage(reason));
      setState("not-configured");
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
            Enter the address of your self-hosted HomePlace server. The desktop app verifies its identity and Link protocol before pairing.
          </p>
        </div>

        <ol className="steps" aria-label="Connection progress">
          {steps.map((step, index) => (
            <li className={index <= current ? "active" : ""} key={step.id}>
              <span>{index + 1}</span>
              {step.label}
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
              disabled={state === "verifying"}
              required
            />
            <button type="submit" disabled={!address.trim() || state === "verifying"}>
              {state === "verifying" ? "Verifying…" : server ? "Verify again" : "Continue"}
            </button>
          </div>
          <p className="hint" id="address-hint">
            Local HTTP stays inside your trusted network. Internet connections require HTTPS.
          </p>
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
        </form>
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
            <p>Device identity will be stored in {platform.secureStorage}, never in interface state or logs.</p>
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
