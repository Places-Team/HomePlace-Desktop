# Architecture

## Goals

HomePlace Desktop must behave like one product while respecting the security,
background-execution rules and interface conventions of Windows, macOS and
Linux. Platform differences are explicit boundaries, not conditional checks
scattered throughout the application.

## Repository layout

```text
HomePlace-Desktop/
├── src/                         # React and TypeScript interface
│   ├── app/                     # Shared application state and routing
│   ├── components/              # Shared controls and content
│   ├── platform/                # Platform-specific visual shells
│   │   ├── macos/
│   │   ├── windows/
│   │   └── linux/
│   └── styles/                  # Shared tokens and platform materials
├── src-tauri/
│   ├── src/
│   │   ├── link/                # HomePlace Link transport and protocol
│   │   ├── identity/            # Device keys and credential references
│   │   ├── capabilities/        # Capability implementations and policy
│   │   ├── transfer/            # Bounded and resumable file transfer
│   │   ├── platform/            # OS adapters
│   │   └── audit/               # Local action history and redaction
│   └── capabilities/            # Tauri permission manifests
├── protocol/                    # Versioned schemas and compatibility fixtures
├── installers/                  # Packaging metadata per platform
└── docs/
```

## Process model

The first release uses one signed desktop application with a tray process. It
keeps a lightweight Link connection while a user session is active. Privileged
or login-screen actions are not silently added to that process.

If a later capability genuinely requires a Windows service, macOS helper or
Linux system service, it will be a small separately permissioned component with
an authenticated local IPC boundary. The UI must remain unprivileged.

## Shared core

The Rust core owns:

- server profile validation and protocol negotiation;
- P-256 device identity and signed Link envelopes;
- WebSocket reconnect, heartbeat and bounded backoff;
- capability registration and permission evaluation;
- command expiry, nonce and replay protection;
- transfer checksums, quotas and cleanup;
- redacted local audit records;
- a narrow typed command surface exposed to the interface.

The interface never receives raw device credentials or private keys.

## Platform adapters

Each adapter implements the same traits only for capabilities that are honest
on that platform. Unsupported capabilities are omitted from the manifest rather
than displayed as disabled promises.

Initial adapters cover:

- secure credential storage;
- autostart and tray lifecycle;
- native notifications;
- foreground application and idle state;
- clipboard read/write under platform privacy rules;
- safe URL and file opening;
- lock, sleep and shutdown where policy permits;
- application launch from an explicit local allowlist.

## Connection profiles

A profile stores the HomePlace server ID, a preferred public or LAN URL,
certificate trust information and a reference to the device credential. The
first release activates one profile at a time while keeping the data model
ready for multiple HomePlace installations.

Plain HTTP is allowed only for loopback and local-network addresses and is
always shown as a reduced-security connection. Cross-host redirects require a
new identity check. Self-signed certificates require explicit fingerprint
confirmation.

## Security boundaries

- No generic shell command capability exists.
- Every remote action is an allowlisted typed command.
- Commands bind server ID, device ID, nonce, issue time and expiry.
- Destructive or privacy-sensitive actions support per-device confirmation
  policies.
- Pairing cannot expand permissions after approval.
- Revocation stops reconnect and clears the active credential.
- Files are never executed automatically and are saved through a user-visible
  destination policy.
- Logs redact credentials, clipboard content, file contents and private URLs.
- Release updates require signed artifacts and a verified update manifest.

## Testing boundaries

The shared core uses deterministic protocol fixtures and simulated transports.
Platform adapters have contract tests plus a small real-machine test matrix.
UI tests run once against shared content and separately for each platform shell.
Release candidates must pair with both LAN-only and HTTPS HomePlace servers.

