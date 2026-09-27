# Temporary exchange

HomePlace Link Desktop supports the server's temporary exchange API. Direct device-to-device sharing remains available in Transfers and the tray shelf. The Temporary link mode creates text or single-file exchanges, lists active links, opens a code, and revokes links. The tray shelf can stage text or one file from a macOS Finder share extension, Windows share arguments, or a drop into this mode.

The paired Link credential stays in Rust and never enters the webview. File uploads and downloads stream without loading the entire file into JavaScript. Downloads are written to a temporary file and moved to the selected destination only after size and SHA-256 verification.

Text is limited to 16 KiB. Before every file upload, Desktop fetches the effective `limits.maxFileBytes` from `/api/link/info` and checks that the server identity matches its paired profile. A server without this field uses the legacy 500 MiB limit. The server can lower its limit as available storage changes, so the upload response remains authoritative. The Desktop implementation supports files up to 10 GiB; the current server setting may be lower.

Expiry choices are 10 minutes, 1 hour, and 1 day. Anyone holding a public link can open it. Account access allows any authenticated user of that HomePlace server with the code; it is not restricted to the creator. One-time text is consumed when opened. A one-time file is consumed when its download starts, so an interrupted download cannot be resumed. Desktop requests a save destination before starting a file download.

Share URLs use the active paired server address and `/x/{code}`. A LAN URL may not work outside the LAN. Copy the code or pair through a reachable domain when sharing remotely.
