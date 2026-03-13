CREATE TABLE IF NOT EXISTS pings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL,
    target      TEXT NOT NULL,
    success     INTEGER NOT NULL,
    latency_ms  REAL,
    dns_ms      REAL,
    error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_pings_timestamp ON pings(timestamp);

CREATE TABLE IF NOT EXISTS outages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    duration_s   REAL,
    cause        TEXT NOT NULL DEFAULT 'isp',
    targets_down TEXT NOT NULL,
    traceroute   TEXT
);
CREATE INDEX IF NOT EXISTS idx_outages_started_at ON outages(started_at);

CREATE TABLE IF NOT EXISTS speed_tests (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp      TEXT NOT NULL,
    download_mbps  REAL NOT NULL,
    upload_mbps    REAL NOT NULL,
    ping_ms        REAL NOT NULL,
    server_name    TEXT,
    trigger_type   TEXT NOT NULL,
    outage_id      INTEGER REFERENCES outages(id)
);
CREATE INDEX IF NOT EXISTS idx_speed_tests_timestamp ON speed_tests(timestamp);

CREATE TABLE IF NOT EXISTS rolling_stats (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp        TEXT NOT NULL,
    window_s         INTEGER NOT NULL,
    packet_loss_pct  REAL NOT NULL,
    jitter_ms        REAL NOT NULL,
    latency_p50      REAL NOT NULL,
    latency_p95      REAL NOT NULL,
    latency_p99      REAL NOT NULL,
    avg_latency_ms   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rolling_stats_timestamp ON rolling_stats(timestamp);

CREATE TABLE IF NOT EXISTS config (
    id                           INTEGER PRIMARY KEY DEFAULT 1,
    targets                      TEXT NOT NULL DEFAULT '["8.8.8.8","1.1.1.1","208.67.222.222"]',
    gateway_ip                   TEXT,
    ping_interval_s              INTEGER NOT NULL DEFAULT 30,
    outage_threshold             INTEGER NOT NULL DEFAULT 3,
    speed_test_cooldown_s        INTEGER NOT NULL DEFAULT 180,
    speed_test_schedule_s        INTEGER NOT NULL DEFAULT 21600,
    auto_speed_test_on_recovery  INTEGER NOT NULL DEFAULT 1,
    data_retention_days          INTEGER NOT NULL DEFAULT 90
);
INSERT OR IGNORE INTO config (id) VALUES (1);
