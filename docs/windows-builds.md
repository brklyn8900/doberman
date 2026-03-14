# Windows Builds

Doberman's Windows packaging is split into two paths:

- CI validation build: `.github/workflows/windows-build.yml`
- Draft release build: `.github/workflows/windows-release.yml`

## CI Build

Use the CI workflow to validate that Windows artifacts still build after code changes.

Triggers:

- `workflow_dispatch`
- pushes to `master` that touch app/build files
- pull requests that touch app/build files

Outputs:

- NSIS installer (`.exe`)
- MSI installer (`.msi`)
- raw `doberman.exe`

These are uploaded as workflow artifacts only.

## Release Build

Use the release workflow when you want downloadable Windows installers for users.

Trigger:

- push a git tag matching `app-v*`
- or run `workflow_dispatch`

The Tauri action will:

- build the Windows installers
- create or update a draft GitHub release for `app-v__VERSION__`
- upload the installer assets to that release
- also upload workflow artifacts for debugging/downloading

## Local Windows Build

From a Windows machine:

```bash
npm ci
npm run tauri:build:windows
```

This uses:

- `src-tauri/tauri.conf.json`
- `src-tauri/tauri.windows.conf.json`

Expected output paths:

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/
src-tauri/target/x86_64-pc-windows-msvc/release/
```

## Current State

- Windows packaging is currently unsigned.
- The stable WiX upgrade code is `bcfbddb1-bc33-5ff6-8000-c829be41b5ac`.
- WebView2 is configured to install via the bootstrapper if needed.

## Next Hardening Step

Add Windows code signing so downloaded installers show a verified publisher instead of an unsigned warning.
