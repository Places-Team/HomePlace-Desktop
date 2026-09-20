import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { fallbackPlatformInfo, type PlatformInfo } from "./lib/platform";

type ConnectionState = "not-configured" | "verifying" | "pairing" | "connected";

const steps: { id: ConnectionState; label: string }[] = [
  { id: "not-configured", label: "Server" },
  { id: "verifying", label: "Verify" },
  { id: "pairing", label: "Approve" },
  { id: "connected", label: "Connected" },
];

export function App() {
  const [platform, setPlatform] = useState<PlatformInfo>(() => fallbackPlatformInfo(navigator.userAgent));
  const [state, setState] = useState<ConnectionState>("not-configured");
  const [address, setAddress] = useState("");

  useEffect(() => {
    invoke<PlatformInfo>("platform_info").then(setPlatform).catch(() => undefined);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.platform = platform.platform;
  }, [platform.platform]);

  const current = steps.findIndex((step) => step.id === state);

  function verify() {
    if (!address.trim()) return;
    setState("verifying");
    window.setTimeout(() => setState("pairing"), 650);
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
          <span className="status-dot" aria-hidden />
          <p className="eyebrow">Ready to connect</p>
          <h2>Bring this {platform.label} device into HomePlace.</h2>
          <p className="lead">
            Pair with your self-hosted server. HomePlace will see only the capabilities you approve on this computer.
          </p>
        </div>

        <ol className="progress" aria-label="Connection progress">
          {steps.map((step, index) => (
            <li key={step.id} className={index <= current ? "active" : ""}>
              <span>{index + 1}</span>
              {step.label}
            </li>
          ))}
        </ol>

        <div className="connect-form">
          <label htmlFor="server-address">HomePlace server</label>
          <div className="field-row">
            <input
              id="server-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="https://home.example.net or http://192.168.1.20:3200"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <button type="button" onClick={verify} disabled={!address.trim() || state !== "not-configured"}>
              {state === "verifying" ? "Verifying…" : state === "pairing" ? "Waiting for approval" : "Continue"}
            </button>
          </div>
          <p className="hint">Local HTTP stays inside your trusted network. Internet connections require HTTPS.</p>
        </div>
      </section>

      <section className="details-grid">
        <article className="glass-card detail-card">
          <div className="detail-icon">◇</div>
          <div>
            <h3>Platform-native</h3>
            <p>{platform.platform === "macos" ? "Glass materials and a focused menu bar experience." : platform.platform === "windows" ? "Fluent surfaces and a familiar notification-area experience." : "Desktop-neutral controls with compositor-aware materials."}</p>
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
