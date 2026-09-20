# Development plan

## Product scope

HomePlace Desktop connects macOS, Windows and Linux computers to a self-hosted
HomePlace server. It is an agent and a user-facing desktop application, not a
second dashboard. The server owns users, permissions, automation and the audit
timeline; the desktop application owns local capability execution and explicit
user consent.

## Phase 0 — contract and repository foundation

- Scaffold Tauri 2, Rust, React, TypeScript and Vite.
- Add formatting, linting, unit tests and a three-platform build workflow.
- Pin versioned HomePlace Link schemas and compatibility fixtures.
- Define typed errors, logging redaction and application data directories.
- Establish platform adapter traits before adding operating-system code.
- Document supported OS versions and the release-signing model.

Exit criteria: all three targets compile in CI, protocol fixtures pass and the
application opens a platform-specific shell without network access.

## Phase 1 — server profiles and secure pairing

Current progress: live server verification, P-256 device identity, approval
polling, credential persistence, multi-profile migration and switching,
active-profile restart recovery, authenticated heartbeat presence, bounded
reconnect backoff and the first validated device event handler are implemented.
Profiles can be switched from the window or tray and forgotten independently;
revocation, local forget-server and recovery are implemented.

- Accept HTTPS domains, local hostnames, IPv4, IPv6 and HomePlace QR payloads.
- Validate `/api/link/info`, server ID, protocol range, clock skew and TLS
  identity.
- Generate the P-256 device identity in platform-secure storage.
- Submit the capability manifest and display the confirmation code.
- Claim the approved credential exactly once and store only its secure-storage
  reference in application data.
- Implement revocation, forget-server and re-pair flows.

Exit criteria: clean macOS, Windows and Linux machines can pair with LAN and
HTTPS installations, restart and reconnect without exposing credentials.

## Phase 2 — tray, presence and realtime transport

- Add the authenticated WebSocket Link connection with bounded reconnect.
- Report online state, battery, network, idle state and foreground application
  only when the user grants the related capability.
- Implement platform tray or menu bar experiences.
- Show connection diagnostics without leaking private data.
- Stop active connections immediately after server revocation.

Exit criteria: presence remains accurate across sleep, wake, network changes,
logout and server restart.

Current progress: the cross-platform tray, close-to-background lifecycle and
native heartbeat scheduler are implemented. Resume events and explicit tray
reconnect requests bypass the current backoff, while the single-instance guard
prevents duplicate heartbeat workers. Platform-specific tray polish and
realtime transport remain.

## Phase 3 — notifications, URLs and clipboard

- Receive native notifications with safe action routing. Basic validated
  notification delivery and post-delivery acknowledgement are implemented;
  notification actions remain.
- Open validated HTTP and HTTPS URLs after explicit local approval. The first
  receive path is implemented without exposing the URL to React.
- Send and receive text and clipboard offers with origin device preview. The
  consent-gated receive and native clipboard-write path is implemented.
- Require confirmation for background clipboard writes unless explicitly
  allowed for a trusted device.
- Add per-capability enable, ask and deny policies.

Exit criteria: every advertised capability works on its target platform and
disappears from the manifest when unavailable or denied.

## Phase 4 — files and quick send

- Add drag-and-drop and share-to-device flows.
- Implement bounded small transfers followed by resumable large transfers.
- Verify size, checksum, recipient and expiry before saving.
- Add transfer progress, cancellation, retry and recent history.
- Never execute received content automatically.

Exit criteria: interrupted transfers resume, corrupted transfers are rejected
and expired or cross-user claims cannot retrieve a file.

## Phase 5 — approved system actions

- Lock, sleep and shutdown through typed platform adapters.
- Wake remote computers through server-side Wake-on-LAN routing.
- Launch applications only from a local allowlist with a stable application ID.
- Add confirmation policies and cooldowns for sensitive actions.
- Write command results to both local and HomePlace audit timelines.

Exit criteria: no arbitrary command path exists and permission removal makes
the related action unavailable immediately.

## Phase 6 — handoff and continuity

- Publish the active application and optional document or URL context.
- Offer continuation only to devices that advertise the required capability.
- Keep application mapping local and user-editable.
- Add recent handoff history and explicit privacy controls.

Exit criteria: browser, editor and media handoffs fail safely when the target
application is missing and never expose context to another HomePlace user.

## Phase 7 — packaging and public beta

- Produce signed macOS dmg, Windows msi and Linux deb, rpm and AppImage builds.
- Add opt-in signed update channels and rollback-safe migrations.
- Test autostart, uninstall and credential cleanup.
- Complete accessibility, localization and reduced-motion/transparency passes.
- Publish release checksums, security reporting guidance and support matrix.

Exit criteria: releases install and update on clean supported systems, preserve
device identity during normal upgrades and can be rolled back safely.

Current progress: opt-in cross-platform autostart and hidden tray launch are
implemented. Installer-level startup, upgrade and uninstall tests remain.

## Initial capability matrix

| Capability | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Pairing and presence | Phase 1–2 | Phase 1–2 | Phase 1–2 |
| Native notifications | Phase 3 | Phase 3 | Phase 3 |
| URL open | Phase 3 | Phase 3 | Phase 3 |
| Clipboard send/receive | Phase 3 | Phase 3 | Phase 3 |
| File receive/send | Phase 4 | Phase 4 | Phase 4 |
| Lock and sleep | Phase 5 | Phase 5 | Phase 5, desktop dependent |
| Application launch | Phase 5 | Phase 5 | Phase 5, desktop dependent |
| Handoff | Phase 6 | Phase 6 | Phase 6 |

## Work that must land in HomePlace first

Desktop development can begin with profiles, pairing and interface work, but
these server contracts are required before the corresponding milestones ship:

1. authenticated WebSocket `/api/link/connect`;
2. signed command envelopes with nonce, expiry and acknowledgement;
3. capability-derived actions and per-device permission policies;
4. device command and confirmation audit timeline;
5. resumable transfer sessions and quotas;
6. handoff event types and target capability matching;
7. automation triggers and actions backed by the same command model.

## Release order

macOS is the first polished visual target because it defines the glass design
and menu bar experience. Windows and Linux remain buildable from Phase 0 and
receive functional parity milestone by milestone. A visual lead on macOS does
not permit protocol or security drift between platforms.
