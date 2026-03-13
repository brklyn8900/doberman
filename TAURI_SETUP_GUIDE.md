# Tauri v2 Setup Guide — Doberman ISP Uptime Monitor

> Research compiled for the Doberman project. Stack: Rust + Tauri v2 + React + TypeScript + Vite.
> Last updated: 2026-03-13

---

## Table of Contents

1. [Current Versions](#1-current-versions)
2. [Project Structure](#2-project-structure)
3. [Cargo.toml](#3-cargotoml)
4. [build.rs](#4-buildrs)
5. [src/main.rs and src/lib.rs](#5-srcmainrs-and-srclibrs)
6. [Axum Integration](#6-axum-integration-within-tauri)
7. [SQLite with sqlx](#7-sqlite-with-sqlx)
8. [tauri.conf.json (v2 format)](#8-tauriconfjson-v2-format)
9. [Permissions System (v2)](#9-tauri-v2-permissions-system)
10. [IPC: Commands and invoke()](#10-tauri-v2-ipc-tauricommand-and-invoke)
11. [vite.config.ts](#11-viteconfigts)
12. [package.json](#12-packagejson)
13. [v1 → v2 Key Differences](#13-v1--v2-key-differences-summary)
14. [Doberman-Specific Notes](#14-doberman-specific-notes)

---

## 1. Current Versions

| Package | Version |
|---------|---------|
| `tauri` (Rust crate) | `2` (latest 2.x) |
| `tauri-build` | `2` |
| `@tauri-apps/api` (npm) | `^2` |
| `@tauri-apps/cli` (npm) | `^2` |

---

## 2. Project Structure

```
doberman/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── index.html
├── public/
│   └── (static assets)
├── src/                              # React frontend
│   ├── main.tsx
│   ├── App.tsx
│   └── assets/
└── src-tauri/                        # Rust backend (Cargo project)
    ├── Cargo.toml
    ├── Cargo.lock                    # Commit this file
    ├── build.rs
    ├── tauri.conf.json
    ├── icons/                        # App icons (.png, .icns, .ico)
    ├── migrations/                   # sqlx migration files
    │   ├── 0001_initial.sql
    │   └── 0002_add_indexes.sql
    ├── capabilities/                 # v2 permissions (replaces v1 allowlist)
    │   └── default.json
    └── src/
        ├── main.rs                   # Desktop entry point (thin wrapper only)
        └── lib.rs                    # All app logic + mobile entry point
```

**Critical v2 rule**: All logic goes in `lib.rs`, not `main.rs`. This is required for mobile support and is the Tauri v2 convention.

---

## 3. Cargo.toml

```toml
[package]
name = "doberman"
version = "0.1.0"
edition = "2021"
rust-version = "1.77.2"

# Required for mobile support
[lib]
name = "doberman_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }

# Serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# Async runtime — reuse Tauri's built-in tokio runtime
tokio = { version = "1", features = ["full"] }
tokio-stream = "0.1"

# Local HTTP API server (runs alongside Tauri, same process)
axum = "0.8"

# ICMP ping for connectivity checks
surge-ping = "0.8"

# SQLite — direct sqlx (not tauri-plugin-sql, since all DB access is in Rust)
sqlx = { version = "0.8", features = [
    "runtime-tokio",   # Use tokio runtime
    "sqlite",          # SQLite driver
    "migrate",         # sqlx::migrate! macro support
    "macros",          # query! and query_as! macros
] }

# Time
chrono = { version = "0.4", features = ["serde"] }

# Logging
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

[features]
# custom-protocol is required for production builds (Tauri serves its own assets)
# tauri-build automatically toggles this feature
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

**Notes:**
- `tokio/full` is fine for development; in production you can trim to `rt-multi-thread,macros,net,time,sync,io-util`.
- Do NOT create a second `tokio::Runtime`. Use `tauri::async_runtime::spawn` (see section 6).
- Use `sqlx` directly (not `tauri-plugin-sql`) since all database access is in Rust commands, not JavaScript.

---

## 4. build.rs

```rust
fn main() {
    tauri_build::build()
}
```

This reads `tauri.conf.json`, generates capability schemas in `src-tauri/gen/schemas/`, and handles the `custom-protocol` feature gate.

---

## 5. src/main.rs and src/lib.rs

**`src-tauri/src/main.rs`** — thin wrapper only:
```rust
// Prevents extra console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    doberman_lib::run();
}
```

**`src-tauri/src/lib.rs`** — all app logic:
```rust
use std::sync::Arc;
use tauri::Manager;

mod commands;
mod db;
mod monitor;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .init();

    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();

            // Initialize database
            let pool = tauri::async_runtime::block_on(db::setup(&handle))
                .expect("database setup failed");
            let pool = Arc::new(pool);

            // Register pool in Tauri's state manager
            app.manage(pool.clone());

            // Spawn axum HTTP server on Tauri's tokio runtime
            tauri::async_runtime::spawn(async move {
                crate::monitor::start_api_server(handle, pool).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_hosts,
            commands::add_host,
            commands::get_outage_report,
            commands::get_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

## 6. Axum Integration Within Tauri

Run axum **in-process** using Tauri's built-in tokio runtime. This avoids creating a second runtime and allows shared state between axum handlers and Tauri commands.

```rust
// src-tauri/src/monitor.rs
use axum::{Router, routing::get, routing::post};
use std::sync::Arc;
use sqlx::SqlitePool;
use tauri::AppHandle;

#[derive(Clone)]
pub struct ApiState {
    pub db: Arc<SqlitePool>,
    pub app: AppHandle,
}

pub async fn start_api_server(app: AppHandle, db: Arc<SqlitePool>) {
    let state = ApiState { db, app };

    let router = Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/outages", get(get_outages_handler))
        .route("/api/status", get(get_status_handler))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3001")
        .await
        .expect("failed to bind API server");

    tracing::info!("API server listening on http://127.0.0.1:3001");
    axum::serve(listener, router).await.expect("API server error");
}

async fn health_handler() -> &'static str {
    "ok"
}

async fn get_outages_handler(
    axum::extract::State(state): axum::extract::State<ApiState>,
) -> impl axum::response::IntoResponse {
    // query state.db
    axum::Json(serde_json::json!({ "outages": [] }))
}
```

**Sharing state between axum and Tauri commands:**

```rust
// Both axum handlers and Tauri commands can access the same pool:

// In axum handler:
async fn handler(State(state): State<ApiState>) -> impl IntoResponse {
    let rows = sqlx::query!("SELECT * FROM outages")
        .fetch_all(&*state.db)
        .await
        .unwrap();
    // ...
}

// In Tauri command:
#[tauri::command]
async fn get_outage_report(
    pool: tauri::State<'_, Arc<SqlitePool>>,
) -> Result<Vec<Outage>, String> {
    sqlx::query_as!(Outage, "SELECT * FROM outages ORDER BY started_at DESC")
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| e.to_string())
}
```

**Frontend calling axum** via `fetch()`:
```typescript
const res = await fetch('http://localhost:3001/api/outages');
const data = await res.json();
```

The CSP in `tauri.conf.json` must allow this (see section 8).

**Why in-process over sidecar?**
- No IPC overhead — same memory space
- Simpler deployment — one binary
- Shared connection pool and app state
- Use sidecar only if you need process isolation or a different executable

---

## 7. SQLite with sqlx

```rust
// src-tauri/src/db.rs
use sqlx::{SqlitePool, migrate::MigrateDatabase, Sqlite};
use tauri::Manager;

pub async fn setup(app: &tauri::AppHandle) -> Result<SqlitePool, sqlx::Error> {
    // Platform-appropriate app data directory (e.g., ~/Library/Application Support/doberman)
    let app_dir = app
        .path()
        .app_data_dir()
        .expect("failed to get app data dir");

    std::fs::create_dir_all(&app_dir)
        .expect("failed to create app data dir");

    let db_path = app_dir.join("doberman.db");
    let db_url = format!("sqlite:{}", db_path.display());

    tracing::info!("Database path: {}", db_path.display());

    // Create database file if it doesn't exist
    if !Sqlite::database_exists(&db_url).await.unwrap_or(false) {
        tracing::info!("Creating database");
        Sqlite::create_database(&db_url).await?;
    }

    let pool = SqlitePool::connect(&db_url).await?;

    // Run migrations from src-tauri/migrations/
    // Path is relative to CARGO_MANIFEST_DIR (i.e., src-tauri/)
    sqlx::migrate!("./migrations").run(&pool).await?;

    tracing::info!("Database ready");
    Ok(pool)
}
```

**Migration file naming** (`src-tauri/migrations/`):
```
0001_initial.sql
0002_add_indexes.sql
0003_add_reports.sql
```

**Example migration** (`0001_initial.sql`):
```sql
CREATE TABLE IF NOT EXISTS hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    label TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ping_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id INTEGER NOT NULL REFERENCES hosts(id),
    latency_ms REAL,
    reachable INTEGER NOT NULL,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id INTEGER NOT NULL REFERENCES hosts(id),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_seconds INTEGER
);
```

---

## 8. tauri.conf.json (v2 Format)

```json
{
  "$schema": "../node_modules/@tauri-apps/cli/schema.json",
  "productName": "Doberman",
  "version": "0.1.0",
  "identifier": "com.doberman.isp-monitor",
  "build": {
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build",
    "devUrl": "http://localhost:5173",
    "frontendDist": "../dist"
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  },
  "app": {
    "windows": [
      {
        "title": "Doberman — ISP Monitor",
        "width": 1280,
        "height": 800,
        "minWidth": 900,
        "minHeight": 600,
        "resizable": true,
        "fullscreen": false
      }
    ],
    "security": {
      "csp": "default-src 'self' tauri: asset: 'unsafe-inline'; connect-src 'self' http://localhost:3001 ipc: http://ipc.localhost"
    }
  }
}
```

**Key v2 changes from v1:**

| Field | v1 location | v2 location |
|-------|-------------|-------------|
| Product name | `package.productName` | top-level `productName` |
| Bundle ID | `tauri.bundle.identifier` | top-level `identifier` |
| API permissions | `tauri.allowlist` | `capabilities/*.json` files |
| Dev URL | `build.devPath` | `build.devUrl` |
| Dist dir | `build.distDir` | `build.frontendDist` |
| Config root key | `tauri {}` | `app {}` |

---

## 9. Tauri v2 Permissions System

v2 replaces the `allowlist` in `tauri.conf.json` with capability files in `src-tauri/capabilities/`.

**`src-tauri/capabilities/default.json`:**
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capabilities for the main window",
  "windows": ["main"],
  "permissions": [
    "core:path:default",
    "core:event:default",
    "core:window:default",
    "core:app:default",
    "core:image:default",
    "core:resources:default",
    "core:menu:default",
    "core:tray:default"
  ]
}
```

**Permission format**: `<plugin-name>:<permission-name>`
- `core:*` — built-in Tauri APIs
- Third-party plugins ship their own permissions
- Custom Rust commands (via `invoke_handler`) are accessible to all windows by default

All files in `src-tauri/capabilities/` are automatically applied.

---

## 10. Tauri v2 IPC: #[tauri::command] and invoke()

**Rust commands** (`src-tauri/src/commands.rs`):
```rust
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use sqlx::SqlitePool;

#[derive(Serialize, Deserialize, Debug)]
pub struct Host {
    pub id: i64,
    pub address: String,
    pub label: Option<String>,
    pub enabled: bool,
}

#[derive(Serialize)]
pub struct AppStatus {
    pub monitoring: bool,
    pub host_count: i64,
    pub last_check: Option<String>,
}

#[tauri::command]
pub async fn get_hosts(
    pool: tauri::State<'_, Arc<SqlitePool>>,
) -> Result<Vec<Host>, String> {
    sqlx::query_as!(Host,
        "SELECT id, address, label, enabled as \"enabled: bool\" FROM hosts ORDER BY id"
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_host(
    address: String,
    label: Option<String>,
    pool: tauri::State<'_, Arc<SqlitePool>>,
) -> Result<i64, String> {
    let result = sqlx::query!(
        "INSERT INTO hosts (address, label) VALUES (?, ?)",
        address,
        label
    )
    .execute(pool.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    Ok(result.last_insert_rowid())
}

// Synchronous commands are also fine
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
```

**Registration in lib.rs:**
```rust
.invoke_handler(tauri::generate_handler![
    commands::get_hosts,
    commands::add_host,
    commands::app_version,
])
```

**TypeScript frontend:**
```typescript
import { invoke } from '@tauri-apps/api/core';  // NOTE: /core not /tauri (v2 change)

interface Host {
  id: number;
  address: string;
  label: string | null;
  enabled: boolean;
}

// Arguments: JS camelCase → Rust snake_case (auto-converted by Tauri)
const hosts = await invoke<Host[]>('get_hosts');

const newId = await invoke<number>('add_host', {
  address: '8.8.8.8',
  label: 'Google DNS',
});

// Error handling
try {
  const result = await invoke<Host[]>('get_hosts');
} catch (err) {
  // err is the String returned from Err(...) in Rust
  console.error('Command failed:', err);
}
```

**IPC rules:**
- Argument names: Rust `snake_case` ↔ JS `camelCase` (auto-converted)
- Return `Result<T, String>` — the `String` becomes the JS rejection value
- `tauri::State<'_, T>` requires `Arc<T>` for async commands (can't hold borrow across await)
- Async commands run on Tauri's tokio runtime — non-blocking
- Import from `@tauri-apps/api/core` in v2 (was `@tauri-apps/api/tauri` in v1)

---

## 11. vite.config.ts

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],

  // Don't clear console — keeps Tauri logs visible
  clearScreen: false,

  server: {
    port: 5173,
    strictPort: true,  // Fail if port taken (don't silently use another port)
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      // Don't trigger Vite rebuilds on Rust file changes
      ignored: ['**/src-tauri/**'],
    },
  },

  envPrefix: ['VITE_', 'TAURI_ENV_*'],

  build: {
    // WebView2 on Windows = Chrome 105+; WebKit on macOS/Linux = Safari 13+
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
```

---

## 12. package.json

```json
{
  "name": "doberman",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "^2",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "recharts": "^2.x",
    "@tanstack/react-table": "^8.x",
    "date-fns": "^3.x"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "@types/react": "^18.3.1",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "tailwindcss": "^3.x",
    "typescript": "^5.6.3",
    "vite": "^6.0.3"
  }
}
```

**Workflow:**
```bash
npm run tauri dev      # Start Vite dev server + launch Tauri app
npm run tauri build    # Build frontend + compile Rust + bundle installer
npm run dev            # Vite only (no Tauri)
```

---

## 13. v1 → v2 Key Differences Summary

| Topic | Tauri v1 | Tauri v2 |
|-------|----------|----------|
| Crate version | `tauri = "1"` | `tauri = "2"` |
| Main logic | `src/main.rs` | `src/lib.rs` (main.rs is thin) |
| Config root | `tauri { ... }` | `app { ... }` |
| Product name | `package.productName` | top-level `productName` |
| Bundle ID | `tauri.bundle.identifier` | top-level `identifier` |
| API permissions | `tauri.allowlist` in conf | `capabilities/*.json` files |
| Dev URL key | `build.devPath` | `build.devUrl` |
| Dist dir key | `build.distDir` | `build.frontendDist` |
| Window type | `Window` | `WebviewWindow` |
| Window lookup | `get_window()` | `get_webview_window()` |
| JS imports | `@tauri-apps/api/tauri` | `@tauri-apps/api/core` |
| Tray icon config | `tauri.systemTray` | `app.trayIcon` |
| Signing env var | `TAURI_PRIVATE_KEY` | `TAURI_SIGNING_PRIVATE_KEY` |
| Platform env var | `TAURI_PLATFORM` | `TAURI_ENV_PLATFORM` |

---

## 14. Doberman-Specific Notes

### surge-ping and raw sockets
`surge-ping` uses ICMP (raw sockets). On **macOS** and **Windows**, unprivileged ICMP works for desktop apps. On **Linux**, the app may need `CAP_NET_RAW` or must run as root. Consider falling back to a TCP connect probe as an alternative connectivity check.

### Architecture: axum vs. Tauri commands
Use this split:
- **Tauri commands** (`invoke()`): OS-level operations — file paths, app data dir, system info, tray icon, notifications
- **axum REST API** (`fetch()`): Data queries, report generation, streaming (via SSE or WebSocket), anything recharts needs

This separation keeps the React components clean (standard `fetch` calls) and allows the API to be tested independently.

### SQLite path
`app.path().app_data_dir()` returns:
- macOS: `~/Library/Application Support/com.doberman.isp-monitor/`
- Windows: `%APPDATA%\com.doberman.isp-monitor\`
- Linux: `~/.local/share/com.doberman.isp-monitor/`

### Background monitoring loop
The ping monitor runs as a tokio task, spawned in `setup()`:
```rust
tauri::async_runtime::spawn(async move {
    monitor::run_ping_loop(pool, interval_secs).await;
});
```

Use `tokio::time::interval` for the ping cycle. Write results to SQLite via the shared pool.

### CSP for axum API calls
The `connect-src` in the CSP must include `http://localhost:3001` for the frontend to reach axum:
```json
"csp": "default-src 'self' tauri: asset: 'unsafe-inline'; connect-src 'self' http://localhost:3001 ipc: http://ipc.localhost"
```

### Do NOT create a second tokio runtime
Tauri owns a tokio runtime. Always use:
```rust
tauri::async_runtime::spawn(async move { ... });
tauri::async_runtime::block_on(async { ... });  // only in non-async context
```

Never call `tokio::runtime::Runtime::new()` — this creates a second runtime and can cause subtle bugs.
