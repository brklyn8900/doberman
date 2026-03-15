# Doberman

Doberman is a desktop internet outage monitor built with Tauri 2, Rust, React, and Vite. It continuously checks your connection, records outages locally, and gives you a desktop UI for history, exports, heatmaps, speed tests, and notification-driven monitoring.

The app is designed to feel like a native desktop utility rather than a browser tab. It runs as a local desktop app, stores its data on-device, exposes an internal localhost API for the frontend, and hides to the system tray instead of quitting when you close the window.

## Features

- Continuous connection monitoring with configurable targets and outage thresholds
- Local outage history with timestamps, durations, causes, and traceroute capture
- Desktop notifications for outage and recovery events
- Manual test notifications from the Settings panel
- Speed test tracking with manual and scheduled runs
- Heatmap and report views for outage analysis
- CSV and PDF-style report export from the local dataset
- Tray-based desktop behavior instead of browser-style app flow

## Platform Notes

- macOS notifications use a native `UserNotifications.framework` backend.
- Windows packaging is available through GitHub Actions and local Windows builds.
- Windows speed tests can auto-download the Ookla CLI into the app data directory on first use.
- Current Windows installers are unsigned, so SmartScreen / unknown publisher warnings are expected for external users.
- The macOS app currently targets macOS 11.0+.

## Stack

- Tauri 2
- Rust
- React 18
- Vite
- TypeScript
- Tailwind CSS 4
- shadcn/ui components
- SQLite via `sqlx`
- Axum for the internal API

## Project Structure

```text
src/                React UI
src-tauri/src/      Rust app, monitoring logic, tray, notifications, API
src-tauri/migrations/ SQLite schema migrations
.github/workflows/  Windows CI and release workflows
docs/               Project-specific build notes
scripts/            Helper scripts, including macOS build/sign flow
```

## Local Development

Prerequisites:

- Node.js 20+
- Rust stable
- Tauri desktop prerequisites for your OS

Install dependencies:

```bash
npm ci
```

Run the frontend only:

```bash
npm run dev
```

Run the desktop app in development:

```bash
npm run tauri -- dev
```

Build the frontend:

```bash
npm run build
```

Check the Rust backend:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

## Packaging

### macOS

Build a signed macOS app bundle:

```bash
npm run tauri:build:macos:app
```

If you want to force a specific signing identity:

```bash
DOBERMAN_APPLE_SIGNING_IDENTITY="Apple Development: Your Name (TEAMID)" npm run tauri:build:macos:app
```

### Windows

From a Windows machine:

```bash
npm ci
npm run tauri:build:windows
```

GitHub Actions is the canonical Windows builder for this repo. See [docs/windows-builds.md](docs/windows-builds.md) for the current workflow layout.

## Windows Release Flow

There are two Windows workflows:

- CI build: [windows-build.yml](.github/workflows/windows-build.yml)
- Draft release build: [windows-release.yml](.github/workflows/windows-release.yml)

To create a draft GitHub release with Windows installers:

```bash
git tag app-v0.1.0-test1
git push origin app-v0.1.0-test1
```

That triggers the draft release workflow, which builds the Windows installers and uploads them to a draft GitHub release.

## Data and Runtime Behavior

- Doberman stores its SQLite database and supporting files in the app data directory for the current OS.
- The frontend talks to a local Axum API bound to `127.0.0.1` on a random port.
- Closing the main window hides the app to the tray instead of exiting the process.
- On Windows, the speed test helper may download on first use into the app data directory if the Ookla CLI is not already available.

## Current Caveats

- Windows installers are not code-signed yet.
- DMG/notarization work for macOS is still separate follow-up work.
- The Windows speed test helper flow has been implemented and needs packaged-build verification whenever that path changes.

## License

MIT. See [LICENSE](LICENSE).
