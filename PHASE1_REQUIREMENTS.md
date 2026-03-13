# Doberman — Phase 1 Requirements (Core Monitoring MVP)

**Source:** PRD v1.0, Section 13 (Implementation Phases) + full spec
**Current state:** Fresh git repo. Only `isp-monitor-prd.md` exists. No source files.
**Goal:** Implement the Core Monitoring MVP — continuous ping monitoring, outage detection, SSE event stream, REST API, and a minimal React dashboard.

---

## 1. Project Initialization

### 1.1 Tauri v2 + React + Vite scaffold

Run `cargo tauri init` to produce the canonical structure:

```
doberman/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs
│       ├── db.rs
│       ├── ping.rs
│       ├── outage.rs
│       ├── sse.rs
│       └── api.rs
├── src/
│   ├── App.tsx
│   ├── hooks/
│   │   ├── useSSE.ts
│   │   └── useApi.ts
│   └── components/
│       ├── StatusBanner.tsx
│       └── LiveChart.tsx
├── package.json
├── vite.config.ts
└── tsconfig.json
```

### 1.2 Cargo.toml dependencies (Phase 1)

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon", "notification"] }
tokio = { version = "1", features = ["full"] }
surge-ping = "0.8"
sqlx = { version = "0.8", features = ["sqlite", "runtime-tokio", "chrono"] }
axum = { version = "0.7", features = ["tokio"] }
tokio-stream = { version = "0.1", features = ["sync"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
chrono = { version = "0.4", features = ["serde"] }
tracing = "0.1"
tracing-subscriber = "0.3"
```

### 1.3 Frontend package.json dependencies (Phase 1)

```json
{
  "dependencies": {
    "react": "^18",
    "react-dom": "^18",
    "recharts": "^2",
    "date-fns": "^3",
    "@tauri-apps/api": "^2"
  },
  "devDependencies": {
    "typescript": "^5",
    "vite": "^5",
    "@vitejs/plugin-react": "^4",
    "tailwindcss": "^3",
    "autoprefixer": "^10",
    "postcss": "^8"
  }
}
```

---

## 2. `main.rs` — Tauri Setup and Task Spawning

**Responsibilities:**
- Initialize the Tauri application builder.
- Open and migrate the SQLite database on startup (via `db::init`).
- Create the `SseBroadcaster` (tokio broadcast channel).
- Spawn background async tasks:
  - `ping::run_ping_loop(db, broadcaster, config_rx)`
  - `outage::run_outage_detector(ping_rx, db, broadcaster)`
- Bind the axum HTTP server on a random available port (`TcpListener::bind("127.0.0.1:0")`).
- Communicate the port to the frontend via Tauri IPC state or a managed state struct.
- Register system tray: icon, menu items (Show Dashboard, Current Status, Run Speed Test, Quit).
- Handle `on_window_event` to intercept close and minimize to tray instead of quitting.

**Key implementation notes:**
- Use `tauri::async_runtime::spawn` for background tasks.
- Share `SqlitePool` and `SseBroadcaster` via `Arc` across tasks and axum state.
- `run_in_background = true` for the axum server task.

---

## 3. `db.rs` — SQLite Setup, Migrations, Queries

### 3.1 Database initialization

```rust
pub async fn init(app_data_dir: &Path) -> Result<SqlitePool>
```

- Path: `{app_data_dir}/doberman.db` (Tauri resolves to platform-specific app data dir).
- On startup, run `PRAGMA integrity_check`. If it fails, rename the corrupted file to `doberman.db.corrupt.{timestamp}` and create a fresh DB.
- Run embedded SQL migrations via `sqlx::migrate!()` pointing to `src-tauri/migrations/`.

### 3.2 Migration files

**`migrations/001_initial.sql`** — create all 5 tables:

#### Table: `pings`
```sql
CREATE TABLE IF NOT EXISTS pings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   DATETIME NOT NULL,
    target      TEXT NOT NULL,
    success     BOOLEAN NOT NULL,
    latency_ms  REAL,
    dns_ms      REAL,
    error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_pings_timestamp ON pings(timestamp);
```

#### Table: `outages`
```sql
CREATE TABLE IF NOT EXISTS outages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at   DATETIME NOT NULL,
    ended_at     DATETIME,
    duration_s   REAL,
    cause        TEXT NOT NULL DEFAULT 'isp',
    targets_down TEXT NOT NULL,
    traceroute   TEXT
);
CREATE INDEX IF NOT EXISTS idx_outages_started_at ON outages(started_at);
```

#### Table: `speed_tests`
```sql
CREATE TABLE IF NOT EXISTS speed_tests (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp      DATETIME NOT NULL,
    download_mbps  REAL NOT NULL,
    upload_mbps    REAL NOT NULL,
    ping_ms        REAL NOT NULL,
    server_name    TEXT,
    trigger        TEXT NOT NULL,
    outage_id      INTEGER REFERENCES outages(id)
);
CREATE INDEX IF NOT EXISTS idx_speed_tests_timestamp ON speed_tests(timestamp);
```

#### Table: `rolling_stats`
```sql
CREATE TABLE IF NOT EXISTS rolling_stats (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp        DATETIME NOT NULL,
    window_s         INTEGER NOT NULL,
    packet_loss_pct  REAL NOT NULL,
    jitter_ms        REAL NOT NULL,
    latency_p50      REAL NOT NULL,
    latency_p95      REAL NOT NULL,
    latency_p99      REAL NOT NULL,
    avg_latency_ms   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rolling_stats_timestamp ON rolling_stats(timestamp);
```

#### Table: `config`
```sql
CREATE TABLE IF NOT EXISTS config (
    id                           INTEGER PRIMARY KEY DEFAULT 1,
    targets                      TEXT NOT NULL DEFAULT '["8.8.8.8","1.1.1.1","208.67.222.222"]',
    gateway_ip                   TEXT,
    ping_interval_s              INTEGER NOT NULL DEFAULT 30,
    outage_threshold             INTEGER NOT NULL DEFAULT 3,
    speed_test_cooldown_s        INTEGER NOT NULL DEFAULT 180,
    speed_test_schedule_s        INTEGER NOT NULL DEFAULT 21600,
    auto_speed_test_on_recovery  BOOLEAN NOT NULL DEFAULT 1,
    data_retention_days          INTEGER NOT NULL DEFAULT 90
);
INSERT OR IGNORE INTO config (id) VALUES (1);
```

### 3.3 Query functions (Phase 1 subset)

```rust
pub async fn insert_ping(pool: &SqlitePool, ping: &PingRecord) -> Result<i64>
pub async fn insert_outage(pool: &SqlitePool, started_at: DateTime<Utc>, cause: &str, targets_down: &[String]) -> Result<i64>
pub async fn close_outage(pool: &SqlitePool, id: i64, ended_at: DateTime<Utc>) -> Result<()>
pub async fn get_config(pool: &SqlitePool) -> Result<Config>
pub async fn update_config(pool: &SqlitePool, update: &ConfigUpdate) -> Result<Config>
pub async fn get_pings(pool: &SqlitePool, params: &PingQueryParams) -> Result<Vec<PingRecord>>
pub async fn get_outages(pool: &SqlitePool, params: &OutageQueryParams) -> Result<Vec<Outage>>
pub async fn get_outage_by_id(pool: &SqlitePool, id: i64) -> Result<Option<Outage>>
pub async fn get_last_ping_per_target(pool: &SqlitePool) -> Result<Vec<PingRecord>>
pub async fn get_active_outage(pool: &SqlitePool) -> Result<Option<Outage>>
```

**Error handling:** All DB writes retry 3 times with exponential backoff (50ms, 100ms, 200ms). On all-retry failure, log with `tracing::error!` and return the error — callers must not crash.

---

## 4. `ping.rs` — Async ICMP Ping Loop

### 4.1 Entry point

```rust
pub async fn run_ping_loop(
    pool: Arc<SqlitePool>,
    broadcaster: Arc<SseBroadcaster>,
    config: Arc<RwLock<Config>>,
)
```

### 4.2 ICMP privilege detection

On startup, attempt `surge_ping::SurgeClient::new()`. If `EACCES`/`EPERM`, set `use_tcp_fallback = true` and emit a `tracing::warn!`. TCP fallback uses `TcpStream::connect_timeout` on port 443.

### 4.3 Ping loop logic

```
loop:
  read config (non-blocking RwLock read)
  spawn JoinSet with one task per target:
    if hostname: measure DNS via tokio::net::lookup_host -> dns_ms
    if use_icmp: surge-ping with 1s timeout -> latency_ms or error
    if use_tcp: TcpStream::connect with 1s timeout -> latency_ms or error
  await all tasks (JoinSet::join_all)
  for each result:
    insert_ping(pool, &result)
    broadcaster.send(SseEvent::PingResult(result))
  sleep(config.ping_interval_s)
```

### 4.4 PingRecord struct

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PingRecord {
    pub id: Option<i64>,
    pub timestamp: DateTime<Utc>,
    pub target: String,
    pub success: bool,
    pub latency_ms: Option<f64>,
    pub dns_ms: Option<f64>,
    pub error: Option<String>,
}
```

### 4.5 Outage cause tagging

After each round, check gateway reachability (if `config.gateway_ip` is set). Pass `gateway_reachable: bool` to the outage detector via a channel or shared state.

---

## 5. `outage.rs` — UP/DOWN State Machine

### 5.1 Entry point

```rust
pub async fn run_outage_detector(
    mut ping_rx: broadcast::Receiver<SseEvent>,
    pool: Arc<SqlitePool>,
    broadcaster: Arc<SseBroadcaster>,
    config: Arc<RwLock<Config>>,
)
```

### 5.2 State machine

**States:** `Up` | `Down { outage_id: i64, started_at: DateTime<Utc> }`

**Internal tracking:**
- `consecutive_failures: HashMap<String, u32>` — per-target consecutive failure count.
- `current_state: State`

**Transition UP → DOWN:**
- Trigger when `consecutive_failures[target] >= config.outage_threshold` for **2 or more** targets simultaneously.
- Actions:
  1. Classify cause: if `gateway_reachable == false` → `local`; if gateway reachable but externals fail → `isp`; if no gateway configured → `unknown`.
  2. Call `db::insert_outage(...)` → get `outage_id`.
  3. Spawn detached task: `traceroute::run(outage_id, pool)` (non-blocking, 30s timeout).
  4. `broadcaster.send(SseEvent::OutageStart { outage_id, started_at, targets_down, cause })`.
  5. `broadcaster.send(SseEvent::StatusChange { status: "down", timestamp })`.
  6. Transition state to `Down`.

**Transition DOWN → UP:**
- Trigger when at least one **non-gateway** target succeeds.
- Actions:
  1. Call `db::close_outage(outage_id, ended_at)`.
  2. `broadcaster.send(SseEvent::OutageEnd { outage_id, started_at, ended_at, duration_s })`.
  3. `broadcaster.send(SseEvent::StatusChange { status: "up", timestamp })`.
  4. If `config.auto_speed_test_on_recovery`: enqueue recovery speed test (Phase 2).
  5. Reset `consecutive_failures`.
  6. Transition state to `Up`.

**Cause classification logic:**
```
if gateway_ip is set AND gateway ping failed → cause = "local"
else if gateway_ip is set AND gateway ping succeeded → cause = "isp"
else → cause = "unknown"
```

---

## 6. `sse.rs` — SSE Broadcast Channel

### 6.1 SseBroadcaster

```rust
pub struct SseBroadcaster {
    sender: broadcast::Sender<SseEvent>,
}

impl SseBroadcaster {
    pub fn new(capacity: usize) -> Arc<Self>  // capacity = 256
    pub fn send(&self, event: SseEvent)
    pub fn subscribe(&self) -> broadcast::Receiver<SseEvent>
}
```

### 6.2 SseEvent enum — all 7 event types

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SseEvent {
    PingResult {
        target: String,
        success: bool,
        latency_ms: Option<f64>,
        dns_ms: Option<f64>,
        timestamp: DateTime<Utc>,
    },
    OutageStart {
        outage_id: i64,
        started_at: DateTime<Utc>,
        targets_down: Vec<String>,
        cause: String,
    },
    OutageEnd {
        outage_id: i64,
        started_at: DateTime<Utc>,
        ended_at: DateTime<Utc>,
        duration_s: f64,
    },
    StatsUpdate {
        window_s: i64,
        packet_loss_pct: f64,
        jitter_ms: f64,
        latency_p50: f64,
        latency_p95: f64,
        latency_p99: f64,
    },
    SpeedTestStart {
        test_id: i64,
        trigger: String,
    },
    SpeedTestResult {
        test_id: i64,
        download_mbps: f64,
        upload_mbps: f64,
        ping_ms: f64,
        trigger: String,
    },
    StatusChange {
        status: String,   // "up" | "down"
        timestamp: DateTime<Utc>,
    },
}
```

### 6.3 SSE response helper

```rust
pub fn event_to_sse(event: &SseEvent) -> axum::response::sse::Event
```

Serializes to `event: <type>\ndata: <json>\n\n` format.

### 6.4 Snapshot on reconnect

When a new SSE client connects, immediately send a synthetic `StatusChange` + `PingResult` (last known results) before subscribing to new events. This prevents stale UI on reconnect.

---

## 7. `api.rs` — axum REST Endpoints

### 7.1 Router setup

```rust
pub fn build_router(pool: Arc<SqlitePool>, broadcaster: Arc<SseBroadcaster>) -> Router
```

Axum router with shared state `AppState { pool, broadcaster }`.

### 7.2 Phase 1 endpoints

#### `GET /api/status`
Response:
```json
{
  "status": "up" | "down",
  "active_outage": null | { "id": 1, "started_at": "...", "cause": "isp", "targets_down": [...], "duration_s": 42.5 },
  "last_pings": [
    { "target": "8.8.8.8", "success": true, "latency_ms": 12.3, "timestamp": "..." }
  ],
  "icmp_mode": "icmp" | "tcp"
}
```

#### `GET /api/pings`
Query params: `from` (ISO datetime), `to` (ISO datetime), `target` (string), `limit` (int, default 100, max 1000)
Response: `{ "pings": [...PingRecord], "total": N }`

#### `GET /api/outages`
Query params: `from`, `to`, `cause` (`isp`|`local`|`unknown`), `limit` (default 50)
Response: `{ "outages": [...Outage] }`

#### `GET /api/outages/:id`
Response: `Outage` (full record including `traceroute` text)
Returns 404 if not found.

#### `GET /api/config`
Response: `Config` (single row from config table)

#### `PUT /api/config`
Body: partial `Config` JSON
Response: updated `Config`
Effect: updates config in DB; the ping loop reads config via `Arc<RwLock<Config>>` so changes take effect on the next ping interval.

#### `GET /api/events` — SSE stream
- Sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`.
- Returns `axum::response::Sse` using `broadcaster.subscribe()`.
- Sends keepalive comment (`: keepalive\n\n`) every 15 seconds.
- On connect, sends snapshot events before streaming live events.

### 7.3 Port communication to frontend

After binding, store the port in Tauri managed state:
```rust
app.manage(ApiPort(listener.local_addr().unwrap().port()));
```
Expose a Tauri command:
```rust
#[tauri::command]
fn get_api_port(state: tauri::State<ApiPort>) -> u16 { state.0 }
```

---

## 8. Frontend — React Components

### 8.1 `hooks/useSSE.ts`

```typescript
export function useSSE(port: number): {
  lastEvent: SseEvent | null;
  connected: boolean;
}
```

- Creates `EventSource(`http://localhost:${port}/api/events`)`.
- Parses `MessageEvent.data` as JSON.
- Auto-reconnects on `onerror` with 2-second delay.
- Cleans up on unmount.

### 8.2 `hooks/useApi.ts`

```typescript
export function useApi(port: number): {
  fetchStatus: () => Promise<StatusResponse>;
  fetchPings: (params?: PingParams) => Promise<PingResponse>;
  fetchOutages: (params?: OutageParams) => Promise<OutageResponse>;
  fetchOutage: (id: number) => Promise<Outage>;
  fetchConfig: () => Promise<Config>;
  updateConfig: (update: Partial<Config>) => Promise<Config>;
}
```

### 8.3 `components/StatusBanner.tsx`

**Props:** `{ status: SseStatusEvent | null, lastPings: PingRecord[] }`

**Visual states:**
- **Connected (green):** Large green indicator, text "Connected", last ping latency (e.g., "12ms to 8.8.8.8"), time since last ping.
- **Outage (red):** Large red indicator, text "Outage Detected", running live timer showing `HH:MM:SS` elapsed, list of down targets (e.g., "8.8.8.8, 1.1.1.1"), cause badge ("ISP" | "Local" | "Unknown").

**Implementation notes:**
- Live timer uses `setInterval(1000)` counting from `active_outage.started_at`.
- Derive status from SSE `StatusChange` events, initialized from `/api/status` REST call on mount.
- Tailwind classes: use `bg-green-900/50 border-green-500` for connected, `bg-red-900/50 border-red-500` for outage.

### 8.4 `components/LiveChart.tsx`

**Props:** `{ events: SseEvent[] }`

**Behavior:**
- Recharts `<LineChart>` with a 10-minute rolling window (600 data points max at 1s resolution, or fewer at 30s ping interval).
- Three `<Line>` series:
  - `latency_ms` (primary Y-axis, ms)
  - `jitter_ms` (secondary Y-axis, ms) — derived from `stats_update` events
  - `packet_loss_pct` (secondary Y-axis, %) — derived from `stats_update` events
- Toggle buttons per series (show/hide).
- Outage periods: use Recharts `<ReferenceArea>` with `fill="rgba(239,68,68,0.2)"` between `outage_start` and `outage_end` timestamps.
- X-axis: time formatted as `HH:mm:ss` via `date-fns/format`.
- No polling — all data sourced from SSE event stream buffered in component state.
- Buffer implementation: `useState<ChartPoint[]>()` with `useEffect` appending new SSE events and slicing to last 600 entries.

### 8.5 `App.tsx`

- Calls `invoke('get_api_port')` via `@tauri-apps/api/core` on mount to get the API port.
- Renders `<StatusBanner>` and `<LiveChart>` on the Dashboard view.
- Provides SSE event stream to children via React Context.
- Sidebar with navigation (Dashboard only for Phase 1; others render placeholder).

---

## 9. System Tray Integration

### 9.1 Tray icon

- Two icon assets: `icons/tray-green.png` (16x16, 32x32), `icons/tray-red.png`.
- Default: green. Switch to red when `SseEvent::StatusChange { status: "down" }` is received.
- Update tray icon from Tauri main thread via `app.tray_by_id("main").unwrap().set_icon(...)`.

### 9.2 Tray menu

```
Show Dashboard      (click → focus/show window)
──────────────────
Current Status: ●  Connected / ● Outage (12:34)   [disabled text item, updated dynamically]
──────────────────
Run Speed Test      (Phase 2 — grayed out in Phase 1)
──────────────────
Quit
```

### 9.3 Close-to-tray behavior

In `on_window_event`:
```rust
WindowEvent::CloseRequested { api, .. } => {
    api.prevent_close();
    window.hide().unwrap();
}
```

Quit menu item calls `std::process::exit(0)` (or `app_handle.exit(0)`).

### 9.4 Desktop notifications (Phase 1)

- On `OutageStart`: emit Tauri notification "Internet outage detected" with body "Cause: ISP / Local / Unknown at HH:mm".
- On `OutageEnd`: emit Tauri notification "Internet restored" with body "Outage lasted MM:SS".
- Use `tauri-plugin-notification` (Tauri v2 plugin).

---

## 10. Error Handling Requirements

| Scenario | Handling |
|---|---|
| SQLite write failure | Retry 3× with 50/100/200ms backoff. Log error, continue. |
| ICMP permission denied | Fall back to TCP probes on port 443. Log warning. |
| SSE client disconnect | `broadcast::Receiver` is dropped; sender continues normally. |
| SSE reconnect | Frontend `EventSource` auto-reconnects. Backend sends snapshot on connect. |
| Panic in background task | Wrap with `tokio::spawn` + `catch_unwind` equivalent; log and restart task. |
| Corrupted DB | `PRAGMA integrity_check` on startup. Rename corrupt file, create fresh DB. |

---

## 11. Acceptance Criteria for Phase 1

1. `cargo tauri dev` launches the app without errors on macOS/Linux/Windows.
2. Pings are sent at the configured interval; results appear in `LiveChart` within 1 second.
3. An outage is detected and `StatusBanner` switches to red within 2 ping intervals of connectivity loss.
4. `GET /api/status` returns correct up/down state and active outage details.
5. `GET /api/pings` returns recent ping history with correct timestamps and latency values.
6. `GET /api/outages` returns outage records; `GET /api/outages/:id` includes traceroute text.
7. `GET /api/events` streams SSE events; new ping results appear within 1 second of the ping completing.
8. System tray icon is green when connected, red during an outage.
9. Closing the window hides it to tray; app continues monitoring.
10. Quit from tray menu exits the application completely.
11. `PUT /api/config` updates take effect on the next ping round without restart.
12. Resource usage: <50MB RAM, <1% CPU during steady-state monitoring.

---

## 12. Out of Scope for Phase 1

- Speed test sidecar (`speed_test.rs`) — Phase 2
- Rolling stats computation (`stats.rs`) — Phase 2
- Traceroute detail in API (captured but not surfaced until Phase 2 full outage view)
- `OutageTable`, `StatsPanel`, `SpeedTestPanel`, `HeatmapView`, `ReportExport`, `SettingsPanel` components
- CSV/PDF export endpoints
- Data retention pruning task
- ICMP elevation UI ("Run with ICMP requires password")
- Theme toggle (dark/light)
- Auto-start on login
