# HomePlace Desktop

HomePlace Desktop is the native companion for a self-hosted HomePlace server.
It connects Windows, macOS and Linux computers to HomePlace Link without making
the three platforms look or behave identical.

The application will provide secure device pairing, presence, notifications,
clipboard and file transfer, URL opening, approved system actions and
cross-device handoff. HomePlace remains the control centre and source of truth;
the desktop application advertises only the capabilities the current computer
can safely provide.

## Platform experience

- **macOS:** glass materials, native window vibrancy, a compact menu bar
  experience, Keychain and familiar macOS interaction patterns.
- **Windows:** Fluent styling, Mica or Acrylic where supported, a notification
  area presence and Windows Credential Manager.
- **Linux:** desktop-neutral controls, system tray support where available,
  Secret Service integration and compositor-aware transparency with a solid
  fallback.

The shared core does not force a shared visual shell. Protocol handling,
connection state, cryptography and data models are common; navigation, window
chrome, materials and system integrations can vary by operating system.

## Proposed stack

- Tauri 2 for the desktop shell and distribution surface.
- Rust for the Link client, secure command validation, transfers and platform
  adapters.
- React, TypeScript and Vite for the interface.
- A versioned copy of the HomePlace Link schemas with compatibility tests.

## Status

Phase 0 is complete and Phase 1 is in progress. The repository contains a
working Tauri 2 shell, platform-specific visual treatments, Link protocol
validators, capability boundaries and macOS/Windows/Linux CI checks. The
connection form now verifies the live `/api/link/info` endpoint with strict
address, identity, protocol, response-size and clock-skew checks. It now creates
a P-256 device identity in platform secure storage, submits a bounded pairing
request, polls for approval and stores the one-time device credential without
exposing secrets to the interface. The active profile is restored after restart
and reports authenticated presence to HomePlace. Heartbeats use bounded
reconnect backoff, resume immediately when the computer returns online and
securely deliver validated HomePlace events as native notifications. Links,
shared text and clipboard offers wait for explicit approval before Rust opens
the browser or writes to the system clipboard; their content is never exposed
to the web interface. Events are acknowledged only after the approved local
action. Revocation, secure local forgetting and credential cleanup are also
supported. Desktop can receive bounded files through a native save dialog,
verify their size and SHA-256 in Rust and commit them through a temporary file
without exposing file metadata or contents to the React interface. The native
tray keeps Link active after the window closes, and the Rust heartbeat service
continues independently of the interface.

Users can opt into seamless clipboard mode per HomePlace server. Desktop then
relays newly copied text to the user's other paired devices, applies incoming
clipboard updates automatically and suppresses round-trips with content
hashes. Enabling the mode does not upload the text already in the clipboard.

Users can explicitly enable start-at-login, which launches Link
hidden in the tray without enabling itself by default. Multiple HomePlace
servers can now be paired concurrently, switched from the window or tray and
forgotten independently without exposing their credentials. Realtime transport
is the next connection milestone. A second launch reuses the existing process,
opens its window and requests an immediate reconnect.

The desktop shell provides a compact icon rail that expands on hover or
keyboard focus, with dedicated views for overview, devices, clipboard,
transfers, automations, productivity, notifications and settings. The
Productivity workspace combines a calendar, agenda, reminders, focus sessions
and cross-device continuation. Reminders are loaded from the active HomePlace
account and can be created, completed or deleted after the user approves the
scoped `reminder.manage` permission during pairing. Implemented capabilities
remain interactive while future flows are clearly marked as previews.

The interface supports persistent Russian and English language selection. Its
expandable navigation uses a bundled SVG icon system so controls remain crisp,
legible and independent of external icon services.

The first functional milestone is pairing with a HomePlace server, storing the
device credential securely and reporting presence from the system tray.

See [Development plan](docs/DEVELOPMENT_PLAN.md),
[Architecture](docs/ARCHITECTURE.md) and
[Platform design](docs/PLATFORM_DESIGN.md).

## Related projects

- [HomePlace](https://github.com/Places-Team/HomePlace) — self-hosted server and
  web control centre.
- [HomePlace Mobile](https://github.com/Places-Team/HomePlace-Mobile) — Android
  and iOS companion.

## License

The project is intended to use the same Apache-2.0 license as HomePlace. The
license file will be added with the first application scaffold.
