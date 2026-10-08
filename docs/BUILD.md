# Build and packaging

## Supported toolchain

- Node.js 22 LTS or 24 Current
- npm 10 or newer
- Rust 1.98.1, pinned by `rust-toolchain.toml`
- Tauri 2 prerequisites for the target operating system

Use the committed `package-lock.json` and `Cargo.lock`; do not regenerate either
lockfile as part of an unrelated platform change.

## Development checks

```text
npm ci
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

Start the native development shell with `npm run tauri dev`.

### Browser interaction checks

With Vite running on port 1420, run `python scripts/test-ui.py` from a Python
environment with `playwright` installed and its Chromium browser downloaded
(`python -m playwright install chromium`). The tests cover sidebar focus,
Snap Layout keyboard navigation, Quick Share drafts and queued requests, and
shared transfer status and cross-window cancellation in both directions.
Quick Share uses a mock native boundary: no real files are read or sent and no
pairing data is changed. Screenshots are written to the temporary directory
under `homeplace-ui-checks`. Native Explorer, drag and cross-device transfers
still require tests in the installed application.

Quick Share and the main composer use the same native outgoing-transfer state
and sender. Both windows display progress, completion, failure and cancellation.
The last 20 outgoing entries are kept in memory for the current app session;
they are not a persistent server-side history. Windows Quick Share uses a
persistent window with a fixed header and a separately scrolling content area.

## Windows installers

Windows packaging requires the Microsoft C++ Build Tools and WebView2 runtime
described by the Tauri prerequisites. Build both supported installer formats
with:

```text
npm run tauri:build:windows
```

Artifacts are written below `src-tauri/target/release/bundle/msi` and
`src-tauri/target/release/bundle/nsis`. The `Build Windows` workflow runs the
same command on `windows-latest` and uploads unsigned installers for internal
testing. Public releases must add certificate signing and must not publish these
unsigned CI artifacts as production builds.

On first launch, the Windows build registers the per-user Explorer action
`Share with HomePlace`. It accepts up to 20 selected files and opens the
persistent Quick Share window; elevation is not required.

macOS and Linux continue to use the shared `Check` workflow. Platform-specific
packaging should live in separate workflows so installer changes can be reviewed
without coupling the three release pipelines.
