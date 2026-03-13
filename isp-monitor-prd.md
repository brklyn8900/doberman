# ISP Uptime Monitor — Product Requirements Document

**Version:** 1.0
**Date:** March 2026

---

## 1. Overview

ISP Uptime Monitor is a cross-platform desktop application that continuously monitors a user's internet connection, detects outages, records detailed network telemetry, and compiles evidence-grade reports suitable for ISP chargeback claims or regulatory complaints.

### 1.1 Problem statement

Residential ISP customers experience frequent outages with no reliable way to document them. ISPs dispute customer-reported downtime because there is no independent, timestamped evidence. Users need an always-on, passive monitoring tool that produces verifiable data.

### 1.2 Target user

Non-technical residential ISP customers who experience frequent outages and want documented proof. The application must install and run with zero configuration beyond initial setup.

### 1.3 Technology stack

| Component | Technology | Rationale |
|---|---|---|
| Backend / core engine | Rust (tokio async runtime) | Low resource usage for 24/7 operation, precise timing for latency measurement, reliable long-running process |
| Desktop shell | Tauri v2 | Native packaging for Windows/macOS/Linux, system tray support, small binary size (~5-15MB vs Electron ~150-300MB), built-in installer generation |
| Frontend | React + TypeScript (Vite) | Component ecosystem for charts and tables, fast development iteration, same code runs in all Tauri targets |
| Database | SQLite (via sqlx) | Zero-config embedded database, single-file portable storage, sufficient for local telemetry workloads |
| HTTP framework | axum | Tight tokio integration, WebSocket/SSE support, lightweight |
| Speed testing | speedtest-cli (Ookla) sidecar | Industry-standard measurement ISPs cannot easily dispute, Tauri sidecar bundles per-platform binary |

---

## 2. Architecture

### 2.1 High-level data flow

The application runs as a single Tauri process containing both the Rust backend and the React frontend webview. The Rust backend spawns several concurrent async tasks that share a SQLite database and an SSE broadcast channel.

**Data flow:**

1. Ping loop runs every N seconds, pings all configured targets concurrently, writes results to the `pings` table, and broadcasts each result on the SSE channel.
2. Outage detector subscribes to ping results. When consecutive failures across 2+ targets exceed the configured threshold, it creates an outage record, triggers an automatic traceroute, and broadcasts an `outage_start` event.
3. When connectivity restores, the outage detector closes the outage record, optionally triggers a recovery speed test, and broadcasts an `outage_end` event.
4. Rolling stats task computes jitter, packet loss, and latency percentiles over sliding windows (5min, 1hr, 24hr) and writes to the `rolling_stats` table.
5. React frontend connects to the SSE endpoint on startup and receives all events in realtime. Historical data is fetched via REST.

### 2.2 Project structure

```
isp-monitor/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── src/
│   │   ├── main.rs              # Tauri setup, spawn background tasks
│   │   ├── ping.rs              # Async ping loop (surge-ping crate)
│   │   ├── outage.rs            # Outage detection state machine
│   │   ├── speed_test.rs        # Sidecar wrapper for speedtest-cli
│   │   ├── stats.rs             # Rolling stat computation
│   │   ├── db.rs                # SQLite setup, migrations, queries
│   │   ├── api.rs               # axum REST endpoints
│   │   ├── sse.rs               # SSE event broadcaster
│   │   └── traceroute.rs        # Async traceroute on outage start
│   └── binaries/                # speedtest-cli sidecars per platform
├── src/                         # React frontend (Vite + TypeScript)
│   ├── App.tsx
│   ├── hooks/
│   │   ├── useSSE.ts            # EventSource hook for realtime data
│   │   └── useApi.ts            # REST client hooks
│   ├── components/
│   │   ├── StatusBanner.tsx     # Current up/down status + active outage timer
│   │   ├── LiveChart.tsx        # Realtime latency/jitter/packet loss chart
│   │   ├── OutageTable.tsx      # Historical outage log with filtering
│   │   ├── SpeedTestPanel.tsx   # Manual trigger + results history
│   │   ├── StatsPanel.tsx       # Rolling stats display (MTBF, MTTR, uptime %)
│   │   ├── HeatmapView.tsx      # Time-of-day outage frequency heatmap
│   │   ├── ReportExport.tsx     # Export UI for CSV/PDF reports
│   │   └── SettingsPanel.tsx    # Configuration UI
│   └── api.ts                   # REST client functions
├── package.json
├── vite.config.ts
└── tsconfig.json
```

### 2.3 Rust crate dependencies

| Crate | Purpose |
|---|---|
| tokio | Async runtime for all background tasks |
| surge-ping | Raw ICMP ping with precise latency measurement |
| sqlx (SQLite feature) | Async database access with compile-time query checks |
| axum | HTTP server for REST API and SSE endpoints |
| tokio-stream | SSE broadcast channel implementation |
| serde / serde_json | Serialization for API responses and SSE events |
| chrono | Timestamp handling and duration computation |
| tauri | Desktop shell integration, sidecar management, system tray |
| tracing / tracing-subscriber | Structured logging |

### 2.4 Frontend dependencies

| Package | Purpose |
|---|---|
| react / react-dom | UI framework |
| typescript | Type safety |
| vite | Build tool and dev server |
| recharts | Charts for latency, jitter, packet loss, speed test history |
| @tanstack/react-table | Sortable, filterable outage history table |
| date-fns | Date formatting and relative time display |
| @tauri-apps/api | Tauri IPC and sidecar invocation from frontend |
| tailwindcss | Utility-first styling |

---

## 3. Database Schema

All tables use SQLite. The database file is stored in the Tauri app data directory (platform-specific). Migrations run automatically on startup.

### 3.1 pings

Raw ping results. One row per ping per target. High volume — expect ~2,880 rows/day per target at 30-second intervals.

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique ping ID |
| timestamp | DATETIME | NOT NULL, INDEX | When the ping was sent (UTC) |
| target | TEXT | NOT NULL | IP address or hostname pinged |
| success | BOOLEAN | NOT NULL | Whether a response was received |
| latency_ms | REAL | NULL | Round-trip time in ms (NULL if failed) |
| dns_ms | REAL | NULL | DNS resolution time in ms (NULL for IP targets) |
| error | TEXT | NULL | Error message if ping failed |

### 3.2 outages

Computed outage events. Created when consecutive failures across 2+ targets exceed the configured threshold. Closed when connectivity restores.

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique outage ID |
| started_at | DATETIME | NOT NULL, INDEX | When the outage was first detected (UTC) |
| ended_at | DATETIME | NULL | When connectivity restored (NULL if ongoing) |
| duration_s | REAL | NULL | Computed duration in seconds |
| cause | TEXT | NOT NULL DEFAULT 'isp' | `isp` \| `local` \| `unknown` (based on gateway reachability) |
| targets_down | TEXT | NOT NULL | JSON array of targets that failed |
| traceroute | TEXT | NULL | Traceroute output captured at outage start |

### 3.3 speed_tests

Speed test results from speedtest-cli. Triggered manually, on schedule, or on outage recovery.

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique test ID |
| timestamp | DATETIME | NOT NULL, INDEX | When the test was run (UTC) |
| download_mbps | REAL | NOT NULL | Download speed in Mbps |
| upload_mbps | REAL | NOT NULL | Upload speed in Mbps |
| ping_ms | REAL | NOT NULL | Latency reported by speedtest-cli |
| server_name | TEXT | NULL | Speedtest server used |
| trigger | TEXT | NOT NULL | `manual` \| `scheduled` \| `recovery` |
| outage_id | INTEGER | NULL, FK → outages.id | Associated outage (for recovery-triggered tests) |

### 3.4 rolling_stats

Pre-computed rolling statistics. Avoids expensive queries on raw pings for dashboard display.

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique stat ID |
| timestamp | DATETIME | NOT NULL, INDEX | Window end time (UTC) |
| window_s | INTEGER | NOT NULL | Window duration: 300 (5min), 3600 (1hr), 86400 (24hr) |
| packet_loss_pct | REAL | NOT NULL | Percentage of failed pings in window |
| jitter_ms | REAL | NOT NULL | Standard deviation of latency in window |
| latency_p50 | REAL | NOT NULL | Median latency in ms |
| latency_p95 | REAL | NOT NULL | 95th percentile latency in ms |
| latency_p99 | REAL | NOT NULL | 99th percentile latency in ms |
| avg_latency_ms | REAL | NOT NULL | Mean latency in ms |

### 3.5 config

Single-row configuration table. Updated via the settings UI. Changes take effect immediately without restart.

| Column | Type | Default | Description |
|---|---|---|---|
| id | INTEGER | 1 | Always 1 (single row) |
| targets | TEXT | `["8.8.8.8","1.1.1.1","208.67.222.222"]` | JSON array of ping targets (IPs and/or hostnames) |
| gateway_ip | TEXT | auto-detected | Local gateway/router IP for local vs ISP fault detection |
| ping_interval_s | INTEGER | 30 | Seconds between ping rounds |
| outage_threshold | INTEGER | 3 | Consecutive failures across 2+ targets to declare outage |
| speed_test_cooldown_s | INTEGER | 180 | Minimum seconds between speed tests |
| speed_test_schedule_s | INTEGER | 21600 | Seconds between scheduled speed tests (default 6hr) |
| auto_speed_test_on_recovery | BOOLEAN | true | Run speed test when outage ends |
| data_retention_days | INTEGER | 90 | Days to retain raw ping data before pruning |

---

## 4. API Specification

The Rust backend serves a local HTTP API on a random available port (communicated to the Tauri frontend via IPC). All endpoints return JSON. The API is only accessible from localhost.

### 4.1 REST endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Current connection status: up/down, active outage info, last ping result per target |
| GET | `/api/pings?from=&to=&target=&limit=` | Historical ping results with optional time range, target filter, and pagination |
| GET | `/api/outages?from=&to=&cause=&limit=` | Historical outages with optional filters |
| GET | `/api/outages/:id` | Single outage detail including traceroute |
| GET | `/api/stats?window=300\|3600\|86400` | Latest rolling stats for the specified window |
| GET | `/api/stats/summary` | Dashboard summary: uptime %, MTBF, MTTR for 1hr/24hr/7d/30d |
| GET | `/api/speed-tests?from=&to=&trigger=&limit=` | Speed test history with optional filters |
| POST | `/api/speed-tests/run` | Trigger a manual speed test. Returns 429 if cooldown active. Returns test ID. |
| GET | `/api/speed-tests/:id` | Single speed test result |
| GET | `/api/heatmap?days=7\|30` | Outage frequency by hour-of-day for heatmap visualization |
| GET | `/api/config` | Current configuration |
| PUT | `/api/config` | Update configuration (partial update supported) |
| GET | `/api/export/csv?from=&to=` | Export outage log as CSV |
| GET | `/api/export/report?from=&to=` | Export formatted PDF report with charts and summary stats |

### 4.2 SSE endpoint

**GET `/api/events`**

Server-Sent Events stream. The frontend connects on startup and reconnects automatically on disconnect. Each event has a type field and a JSON data payload.

| Event type | Payload | When emitted |
|---|---|---|
| ping_result | `{target, success, latency_ms, dns_ms, timestamp}` | After every ping round (one event per target) |
| outage_start | `{outage_id, started_at, targets_down, cause}` | When an outage is detected |
| outage_end | `{outage_id, started_at, ended_at, duration_s}` | When connectivity restores |
| stats_update | `{window_s, packet_loss_pct, jitter_ms, latency_p50, latency_p95, latency_p99}` | Every 30 seconds (5min window) or when a window closes |
| speed_test_start | `{test_id, trigger}` | When a speed test begins |
| speed_test_result | `{test_id, download_mbps, upload_mbps, ping_ms, trigger}` | When a speed test completes |
| status_change | `{status: "up"\|"down", timestamp}` | On any up/down transition |

---

## 5. Core Engine Specifications

### 5.1 Ping loop

- Use the `surge-ping` crate for raw ICMP echo requests. Fall back to TCP connect on port 80/443 if ICMP is blocked or requires elevated privileges.
- Ping all configured targets concurrently each interval using `tokio::join!` or `JoinSet`.
- For hostname targets, measure DNS resolution time separately using `tokio::net::lookup_host` before sending the ping.
- Each ping result is written to the `pings` table and broadcast on the SSE channel.
- If the gateway IP is unreachable, tag the event as `cause: local` rather than `cause: isp`.

### 5.2 Outage detection state machine

The outage detector maintains a state machine with two states: **UP** and **DOWN**.

**Transition UP → DOWN:**

- When N consecutive ping rounds show failure across 2 or more targets (where N is `outage_threshold` from config).
- On transition: create an outage record in the database, trigger an async traceroute, broadcast `outage_start`.

**Transition DOWN → UP:**

- When any single ping round shows success for at least one non-gateway target.
- On transition: close the outage record (set `ended_at` and `duration_s`), optionally trigger a recovery speed test, broadcast `outage_end`.

**Cause classification:**

- If gateway is unreachable: `cause = local` (router/modem issue, not ISP).
- If gateway is reachable but external targets are not: `cause = isp`.
- If gateway ping was not configured: `cause = unknown`.

### 5.3 Traceroute

- Triggered automatically when an outage starts.
- Run asynchronously — do not block the ping loop.
- On Windows: invoke `tracert` via `Command`. On Linux/macOS: invoke `traceroute`.
- Capture full output as text and store in the outage record's `traceroute` column.
- Timeout after 30 seconds to avoid hanging during severe outages.

### 5.4 Speed test integration

- Bundle Ookla's `speedtest-cli` as a Tauri sidecar binary (one per target platform).
- Invoke via Tauri's sidecar API with JSON output flag (`speedtest --format=json`).
- Parse JSON output for download/upload bandwidth and latency.
- Enforce cooldown period between tests (configurable, default 180s). Return HTTP 429 if cooldown is active.
- Tag each test with its trigger type: `manual`, `scheduled`, or `recovery`.
- When triggered by recovery, link to the outage via `outage_id` foreign key.
- Broadcast `speed_test_start` and `speed_test_result` events on the SSE channel.

### 5.5 Rolling statistics computation

- Compute stats over sliding windows: 5-minute (for realtime display), 1-hour, and 24-hour.
- Metrics computed per window: packet loss %, jitter (stddev of latency), latency p50/p95/p99, mean latency.
- The 5-minute window is recomputed every 30 seconds. The 1-hour and 24-hour windows are recomputed every 5 minutes.
- Results are written to `rolling_stats` and broadcast via SSE.

### 5.6 Derived summary statistics (computed on-demand via REST)

| Metric | Computation | Display windows |
|---|---|---|
| Uptime % | `(1 - total_outage_seconds / total_window_seconds) * 100` | 1hr, 24hr, 7d, 30d |
| MTBF | `total_window_seconds / number_of_outages` | 24hr, 7d, 30d |
| MTTR | `avg(outage.duration_s)` for closed outages | 24hr, 7d, 30d |
| Outage count | `COUNT` of outages in window | 1hr, 24hr, 7d, 30d |
| Worst outage | `MAX(duration_s)` in window | 24hr, 7d, 30d |

---

## 6. Frontend Specifications

The React frontend is served within a Tauri webview. It connects to the Rust backend via the local HTTP API. The UI should be clean, data-dense, and optimized for a monitoring use case — dark theme by default with light theme option.

### 6.1 Layout

Single-page application with a sidebar navigation and a main content area. The sidebar contains navigation links to each view. The main content area renders the selected view.

**Views:**

1. **Dashboard** (default) — realtime overview with status banner, live chart, and stats summary
2. **Outage log** — historical outage table with filtering and detail view
3. **Speed tests** — speed test history and manual trigger
4. **Heatmap** — time-of-day outage frequency visualization
5. **Reports** — export interface for CSV/PDF
6. **Settings** — configuration panel

### 6.2 Dashboard view

#### 6.2.1 Status banner

- Large, prominent display of current status: green "Connected" or red "Outage Detected".
- When an outage is active: show a running timer counting the duration, the list of down targets, and the detected cause (ISP / Local / Unknown).
- Show last ping latency and time since last successful ping.

#### 6.2.2 Live chart

- Recharts line chart showing the last 10 minutes of data (rolling window).
- Three series togglable: latency (ms), jitter (ms), packet loss (%).
- X-axis: time. Y-axis: auto-scaled per metric.
- Outage periods shown as shaded red regions on the chart background.
- Data sourced from SSE `ping_result` and `stats_update` events. No polling.

#### 6.2.3 Stats summary panel

- Grid of stat cards showing: uptime % (1hr, 24hr, 7d), MTBF, MTTR, outage count today, current jitter, current packet loss %, latency p95.
- Each card shows the current value, a trend indicator (up/down arrow), and a sparkline for the last 24 hours.
- Data fetched via REST on load, updated via SSE events.

### 6.3 Outage log view

- Sortable, filterable table using `@tanstack/react-table`.
- Columns: start time, end time, duration, cause, targets down, speed test on recovery (link to result if available).
- Filters: date range picker, cause dropdown (all/isp/local/unknown), minimum duration.
- Click a row to expand and show the traceroute output and linked speed test details.
- Pagination with configurable page size.

### 6.4 Speed test panel

- "Run Speed Test" button with cooldown indicator (grayed out with countdown timer during cooldown).
- When running: animated progress indicator.
- Result display: download/upload gauges, ping value, server name.
- History table below: timestamp, download, upload, ping, trigger type, linked outage.
- Recharts bar chart showing download/upload over time.

### 6.5 Heatmap view

- 7-day or 30-day view (toggle).
- Grid: X-axis = hour of day (0–23), Y-axis = day of week or date.
- Cell color intensity = number of outages or total downtime minutes in that hour.
- Hover tooltip: exact outage count, total downtime minutes, and individual outage durations.
- Useful for identifying ISP congestion patterns (e.g., evening peak degradation).

### 6.6 Report export view

- Date range selector for the report period.
- Preview panel showing what will be exported.
- Export formats: CSV (outage log only) and PDF (full report with charts and summary).

**PDF report contents:**

1. Summary: total outages, total downtime, uptime %, MTBF, MTTR for the period.
2. Outage table: all outages in the period with timestamps, durations, and causes.
3. Speed test summary: average download/upload, comparison to advertised speeds (user-entered in settings).
4. Latency and packet loss chart over the period.
5. Heatmap for the period.
6. Traceroute excerpts for the 3 longest outages.

### 6.7 Settings panel

| Setting | Input type | Validation |
|---|---|---|
| Ping targets | Text list (add/remove) | Valid IPv4, IPv6, or resolvable hostname. Minimum 2 targets. |
| Gateway IP | Text input + auto-detect button | Valid IPv4. Auto-detect reads default route. |
| Ping interval | Number input (seconds) | Minimum 10s, maximum 300s |
| Outage threshold | Number input | Minimum 2, maximum 10 |
| Speed test cooldown | Number input (seconds) | Minimum 60s |
| Speed test schedule | Number input (hours) | Minimum 1hr, maximum 24hr. 0 to disable. |
| Auto speed test on recovery | Toggle | Boolean |
| Advertised download speed | Number input (Mbps) | Used in PDF report comparison. Optional. |
| Advertised upload speed | Number input (Mbps) | Used in PDF report comparison. Optional. |
| Data retention | Number input (days) | Minimum 7, maximum 365 |
| Theme | Toggle: dark / light | Persisted in config |

---

## 7. System Tray Integration

- The application runs in the system tray when the window is closed (close to tray, not quit).
- Tray icon: green circle when connected, red circle when an outage is active.
- Tray menu items: Show Dashboard, Current Status (disabled text showing up/down + latency), Run Speed Test, Quit.
- Desktop notification on outage start: "Internet outage detected at [time]" with the cause.
- Desktop notification on outage end: "Internet restored after [duration]" with optional speed test result.
- On application quit, the monitoring service stops. No background daemon — the app must be running to monitor.

---

## 8. Cross-Platform Considerations

| Concern | Windows | macOS | Linux |
|---|---|---|---|
| ICMP permissions | Unprivileged (works out of the box) | Requires root or codesigned binary with network entitlement | Requires CAP_NET_RAW or root. Post-install setcap on the binary. |
| Installer format | .msi and .exe (NSIS) via Tauri | .dmg via Tauri | .deb and .AppImage via Tauri |
| Speedtest sidecar | speedtest.exe bundled | speedtest (arm64 + x64) bundled | speedtest (x64) bundled |
| Traceroute command | `tracert` | `traceroute` (pre-installed) | `traceroute` (may need `apt install`) |
| System tray | Native tray icon | Menu bar icon | Depends on DE (GNOME, KDE). Use Tauri's tray abstraction. |
| Auto-start | Registry entry or Task Scheduler | Login items via launchd plist | XDG autostart .desktop file |
| Data directory | `%APPDATA%/isp-monitor/` | `~/Library/Application Support/isp-monitor/` | `~/.local/share/isp-monitor/` |

---

## 9. ICMP Privilege Fallback Strategy

On macOS and Linux, raw ICMP sockets require elevated privileges. The application must handle this gracefully.

1. On startup, attempt to create a raw ICMP socket.
2. If successful, use `surge-ping` for all pinging.
3. If EACCES/EPERM, fall back to TCP connect probes on port 443 for each target. Log a warning and show a settings notification that ICMP is unavailable.
4. TCP fallback measures connection establishment time, which is a reasonable proxy for latency but not identical to ICMP RTT. The UI should indicate when TCP mode is active.
5. Provide a settings option to manually elevate: "Run with ICMP (requires password)" which re-launches with `pkexec`/`osascript`.

---

## 10. Data Retention and Pruning

- A daily maintenance task runs at startup and every 24 hours.
- Deletes raw pings older than `data_retention_days` (default 90).
- Deletes `rolling_stats` rows older than 180 days.
- Outage and speed_test records are retained indefinitely (low volume).
- Runs `VACUUM` after pruning to reclaim disk space.
- Logs the number of deleted rows for diagnostics.

---

## 11. Error Handling and Resilience

- **SQLite write failures:** retry 3 times with exponential backoff. If all retries fail, log the error and continue monitoring (do not crash).
- **Speedtest-cli failure:** log the error, mark the test as failed in the database, and notify the frontend via SSE.
- **SSE connection drop:** the frontend's EventSource automatically reconnects. The backend sends a full status snapshot on each new SSE connection.
- **Network interface change** (e.g., WiFi reconnect): re-detect gateway IP if set to auto-detect.
- **Corrupted database:** on startup, run `PRAGMA integrity_check`. If it fails, back up the file and create a fresh database.
- **Panic recovery:** use tokio's `catch_unwind` on each spawned task. Log the panic and restart the task.

---

## 12. Build and Distribution

### 12.1 Local development

```bash
# Install prerequisites
cargo install tauri-cli
npm install

# Run in development mode
cargo tauri dev
```

### 12.2 Production build

```bash
cargo tauri build
```

Produces platform-specific installers in `src-tauri/target/release/bundle/`.

### 12.3 CI/CD (GitHub Actions)

Use Tauri's official GitHub Action with a matrix build:

- Windows runner → .msi + .exe installer
- macOS runner → .dmg (arm64 + x64 universal)
- Linux runner → .deb + .AppImage

Each build includes the platform-specific speedtest-cli sidecar in the bundle. Release artifacts are uploaded to GitHub Releases.

---

## 13. Implementation Phases

Recommended build order for incremental delivery.

### Phase 1: Core monitoring (MVP)

1. Initialize Tauri v2 project with React + Vite frontend.
2. Implement `db.rs`: SQLite setup, migrations for all 5 tables.
3. Implement `ping.rs`: async ping loop with surge-ping, write to DB.
4. Implement `outage.rs`: state machine, create/close outage records.
5. Implement `sse.rs`: broadcast channel, event types.
6. Implement `api.rs`: `/status`, `/pings`, `/outages`, `/events` endpoints.
7. Build `StatusBanner` and `LiveChart` components.
8. System tray with basic status icon.

### Phase 2: Speed tests and stats

1. Implement `speed_test.rs`: sidecar integration, cooldown logic.
2. Implement `stats.rs`: rolling window computation.
3. Implement `traceroute.rs`: async command execution.
4. Build `SpeedTestPanel`, `StatsPanel` components.
5. Add speed test and stats REST endpoints.

### Phase 3: Historical views and export

1. Build `OutageTable` with filtering and expandable rows.
2. Build `HeatmapView`.
3. Implement CSV export endpoint.
4. Implement PDF report generation.
5. Build `ReportExport` view.

### Phase 4: Polish and distribution

1. Settings panel with live config updates.
2. Desktop notifications for outage start/end.
3. ICMP fallback to TCP with UI indicator.
4. Data retention pruning task.
5. GitHub Actions CI/CD pipeline.
6. Theme support (dark/light).
7. Cross-platform testing and installer validation.

---

## 14. Acceptance Criteria

The application is considered complete when all of the following are satisfied:

1. Application installs and launches on Windows 10+, macOS 12+, and Ubuntu 22.04+ without manual dependency installation.
2. Pings are sent at the configured interval and results are visible in the live chart within 1 second of completion.
3. Outages are detected and recorded within 2 ping intervals of actual connectivity loss.
4. Outage start and end trigger desktop notifications.
5. Speed tests can be triggered manually and show results within 60 seconds.
6. Recovery speed tests fire automatically when configured.
7. The outage log correctly filters by date range, cause, and minimum duration.
8. The heatmap correctly visualizes outage frequency by hour-of-day.
9. CSV export produces a valid file containing all outages in the selected range.
10. PDF report contains all specified sections with accurate data.
11. The application consumes less than 50MB RAM and less than 1% CPU during steady-state monitoring.
12. The system tray icon reflects the current connection status in real time.
13. Closing the window minimizes to tray. Quit from tray menu exits the application.
14. All configuration changes take effect immediately without restart.
15. Data older than the retention period is pruned automatically.

---

## 15. Out of Scope (v1)

- Cloud sync or multi-device aggregation.
- Custom speed test server (uses Ookla's network).
- Direct ISP API integration or automated chargeback filing.
- Mobile companion app.
- IPv6-only network support (IPv6 targets are supported, but the app assumes IPv4 gateway detection).
- Custom alerting integrations (email, webhook, Slack).
