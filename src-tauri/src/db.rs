use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{FromRow, SqlitePool};
use tracing::{error, info};

// ---------------------------------------------------------------------------
// Row structs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PingRecord {
    pub id: Option<i64>,
    pub timestamp: String,
    pub target: String,
    pub success: bool,
    pub latency_ms: Option<f64>,
    pub dns_ms: Option<f64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Outage {
    pub id: Option<i64>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_s: Option<f64>,
    pub cause: String,
    pub targets_down: String,
    pub traceroute: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct SpeedTest {
    pub id: Option<i64>,
    pub timestamp: String,
    pub download_mbps: f64,
    pub upload_mbps: f64,
    pub ping_ms: f64,
    pub server_name: Option<String>,
    pub trigger_type: String,
    pub outage_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct RollingStat {
    pub id: Option<i64>,
    pub timestamp: String,
    pub window_s: i64,
    pub packet_loss_pct: f64,
    pub jitter_ms: f64,
    pub latency_p50: f64,
    pub latency_p95: f64,
    pub latency_p99: f64,
    pub avg_latency_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Config {
    pub id: Option<i64>,
    pub targets: String,
    pub gateway_ip: Option<String>,
    pub ping_interval_s: i64,
    pub outage_threshold: i64,
    pub speed_test_cooldown_s: i64,
    pub speed_test_schedule_s: i64,
    pub auto_speed_test_on_recovery: bool,
    pub data_retention_days: i64,
    pub advertised_download_mbps: Option<f64>,
    pub advertised_upload_mbps: Option<f64>,
}

// ---------------------------------------------------------------------------
// Query parameter structs
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
pub struct PingQueryParams {
    pub from: Option<String>,
    pub to: Option<String>,
    pub target: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
pub struct OutageQueryParams {
    pub from: Option<String>,
    pub to: Option<String>,
    pub cause: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ConfigUpdate {
    pub targets: Option<String>,
    pub gateway_ip: Option<String>,
    pub ping_interval_s: Option<i64>,
    pub outage_threshold: Option<i64>,
    pub speed_test_cooldown_s: Option<i64>,
    pub speed_test_schedule_s: Option<i64>,
    pub auto_speed_test_on_recovery: Option<bool>,
    pub data_retention_days: Option<i64>,
    pub advertised_download_mbps: Option<f64>,
    pub advertised_upload_mbps: Option<f64>,
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

pub async fn init_db(app_data_dir: &Path) -> Result<SqlitePool, sqlx::Error> {
    std::fs::create_dir_all(app_data_dir).ok();

    let db_path = app_data_dir.join("doberman.db");
    info!("Opening database at {}", db_path.display());

    let opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;

    // Integrity check — if it fails, rotate the corrupt file and recreate
    let integrity: (String,) = sqlx::query_as("PRAGMA integrity_check")
        .fetch_one(&pool)
        .await?;
    if integrity.0 != "ok" {
        error!("Database integrity check failed: {}", integrity.0);
        pool.close().await;
        let ts = Utc::now().format("%Y%m%d%H%M%S");
        let corrupt_path = app_data_dir.join(format!("doberman.db.corrupt.{ts}"));
        std::fs::rename(&db_path, &corrupt_path).ok();
        // Reconnect to a fresh database
        let opts = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        info!("Created fresh database after corruption");
        return Ok(pool);
    }

    sqlx::migrate!("./migrations").run(&pool).await?;
    info!("Database migrations applied successfully");
    Ok(pool)
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

async fn retry<F, Fut, T>(f: F) -> Result<T, sqlx::Error>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, sqlx::Error>>,
{
    let delays = [50, 100, 200];
    let mut last_err = None;
    for (i, delay_ms) in delays.iter().enumerate() {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                error!("DB write attempt {}/{} failed: {e}", i + 1, delays.len());
                last_err = Some(e);
                tokio::time::sleep(std::time::Duration::from_millis(*delay_ms)).await;
            }
        }
    }
    Err(last_err.unwrap())
}

// ---------------------------------------------------------------------------
// Ping queries
// ---------------------------------------------------------------------------

pub async fn insert_ping(pool: &SqlitePool, ping: &PingRecord) -> Result<i64, sqlx::Error> {
    retry(|| async {
        let result = sqlx::query(
            "INSERT INTO pings (timestamp, target, success, latency_ms, dns_ms, error)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&ping.timestamp)
        .bind(&ping.target)
        .bind(ping.success)
        .bind(ping.latency_ms)
        .bind(ping.dns_ms)
        .bind(&ping.error)
        .execute(pool)
        .await?;
        Ok(result.last_insert_rowid())
    })
    .await
}

pub async fn get_pings(
    pool: &SqlitePool,
    params: &PingQueryParams,
) -> Result<Vec<PingRecord>, sqlx::Error> {
    let limit = params.limit.unwrap_or(100).min(1000);
    let mut query = String::from("SELECT * FROM pings WHERE 1=1");
    if params.from.is_some() {
        query.push_str(" AND timestamp >= ?");
    }
    if params.to.is_some() {
        query.push_str(" AND timestamp <= ?");
    }
    if params.target.is_some() {
        query.push_str(" AND target = ?");
    }
    query.push_str(" ORDER BY timestamp DESC LIMIT ?");

    let mut q = sqlx::query_as::<_, PingRecord>(&query);
    if let Some(ref from) = params.from {
        q = q.bind(from);
    }
    if let Some(ref to) = params.to {
        q = q.bind(to);
    }
    if let Some(ref target) = params.target {
        q = q.bind(target);
    }
    q = q.bind(limit);
    q.fetch_all(pool).await
}

pub async fn get_last_ping_per_target(
    pool: &SqlitePool,
) -> Result<Vec<PingRecord>, sqlx::Error> {
    sqlx::query_as::<_, PingRecord>(
        "SELECT p.* FROM pings p
         INNER JOIN (SELECT target, MAX(timestamp) as max_ts FROM pings GROUP BY target) latest
         ON p.target = latest.target AND p.timestamp = latest.max_ts",
    )
    .fetch_all(pool)
    .await
}

// ---------------------------------------------------------------------------
// Outage queries
// ---------------------------------------------------------------------------

pub async fn insert_outage(
    pool: &SqlitePool,
    started_at: &DateTime<Utc>,
    cause: &str,
    targets_down: &[String],
) -> Result<i64, sqlx::Error> {
    let started = started_at.to_rfc3339();
    let targets_json = serde_json::to_string(targets_down).unwrap_or_default();
    retry(|| {
        let started = started.clone();
        let targets_json = targets_json.clone();
        let cause = cause.to_string();
        async move {
            let result = sqlx::query(
                "INSERT INTO outages (started_at, cause, targets_down) VALUES (?, ?, ?)",
            )
            .bind(&started)
            .bind(&cause)
            .bind(&targets_json)
            .execute(pool)
            .await?;
            Ok(result.last_insert_rowid())
        }
    })
    .await
}

pub async fn close_outage(
    pool: &SqlitePool,
    id: i64,
    ended_at: &DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    let ended = ended_at.to_rfc3339();
    retry(|| {
        let ended = ended.clone();
        async move {
            sqlx::query(
                "UPDATE outages SET ended_at = ?, duration_s = (julianday(?) - julianday(started_at)) * 86400.0
                 WHERE id = ?",
            )
            .bind(&ended)
            .bind(&ended)
            .bind(id)
            .execute(pool)
            .await?;
            Ok(())
        }
    })
    .await
}

pub async fn get_outages(
    pool: &SqlitePool,
    params: &OutageQueryParams,
) -> Result<Vec<Outage>, sqlx::Error> {
    let limit = params.limit.unwrap_or(50).min(500);
    let mut query = String::from("SELECT * FROM outages WHERE 1=1");
    if params.from.is_some() {
        query.push_str(" AND started_at >= ?");
    }
    if params.to.is_some() {
        query.push_str(" AND started_at <= ?");
    }
    if params.cause.is_some() {
        query.push_str(" AND cause = ?");
    }
    query.push_str(" ORDER BY started_at DESC LIMIT ?");

    let mut q = sqlx::query_as::<_, Outage>(&query);
    if let Some(ref from) = params.from {
        q = q.bind(from);
    }
    if let Some(ref to) = params.to {
        q = q.bind(to);
    }
    if let Some(ref cause) = params.cause {
        q = q.bind(cause);
    }
    q = q.bind(limit);
    q.fetch_all(pool).await
}

pub async fn get_outage_by_id(
    pool: &SqlitePool,
    id: i64,
) -> Result<Option<Outage>, sqlx::Error> {
    sqlx::query_as::<_, Outage>("SELECT * FROM outages WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn update_outage_traceroute(
    pool: &SqlitePool,
    id: i64,
    traceroute: &str,
) -> Result<(), sqlx::Error> {
    let traceroute = traceroute.to_string();
    retry(|| {
        let traceroute = traceroute.clone();
        async move {
            sqlx::query("UPDATE outages SET traceroute = ? WHERE id = ?")
                .bind(&traceroute)
                .bind(id)
                .execute(pool)
                .await?;
            Ok(())
        }
    })
    .await
}

pub async fn get_active_outage(pool: &SqlitePool) -> Result<Option<Outage>, sqlx::Error> {
    sqlx::query_as::<_, Outage>(
        "SELECT * FROM outages WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await
}

// ---------------------------------------------------------------------------
// Speed test queries
// ---------------------------------------------------------------------------

pub async fn insert_speed_test(
    pool: &SqlitePool,
    test: &SpeedTest,
) -> Result<i64, sqlx::Error> {
    retry(|| async {
        let result = sqlx::query(
            "INSERT INTO speed_tests (timestamp, download_mbps, upload_mbps, ping_ms, server_name, trigger_type, outage_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&test.timestamp)
        .bind(test.download_mbps)
        .bind(test.upload_mbps)
        .bind(test.ping_ms)
        .bind(&test.server_name)
        .bind(&test.trigger_type)
        .bind(test.outage_id)
        .execute(pool)
        .await?;
        Ok(result.last_insert_rowid())
    })
    .await
}

pub async fn get_speed_test_by_id(
    pool: &SqlitePool,
    id: i64,
) -> Result<Option<SpeedTest>, sqlx::Error> {
    sqlx::query_as::<_, SpeedTest>("SELECT * FROM speed_tests WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn get_speed_tests(
    pool: &SqlitePool,
    limit: Option<i64>,
) -> Result<Vec<SpeedTest>, sqlx::Error> {
    let limit = limit.unwrap_or(50).min(500);
    sqlx::query_as::<_, SpeedTest>(
        "SELECT * FROM speed_tests ORDER BY timestamp DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
}

// ---------------------------------------------------------------------------
// Rolling stats queries
// ---------------------------------------------------------------------------

pub async fn insert_rolling_stat(
    pool: &SqlitePool,
    stat: &RollingStat,
) -> Result<i64, sqlx::Error> {
    retry(|| async {
        let result = sqlx::query(
            "INSERT INTO rolling_stats (timestamp, window_s, packet_loss_pct, jitter_ms, latency_p50, latency_p95, latency_p99, avg_latency_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&stat.timestamp)
        .bind(stat.window_s)
        .bind(stat.packet_loss_pct)
        .bind(stat.jitter_ms)
        .bind(stat.latency_p50)
        .bind(stat.latency_p95)
        .bind(stat.latency_p99)
        .bind(stat.avg_latency_ms)
        .execute(pool)
        .await?;
        Ok(result.last_insert_rowid())
    })
    .await
}

pub async fn get_latest_stats(
    pool: &SqlitePool,
) -> Result<Option<RollingStat>, sqlx::Error> {
    sqlx::query_as::<_, RollingStat>(
        "SELECT * FROM rolling_stats ORDER BY timestamp DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await
}

// ---------------------------------------------------------------------------
// Heatmap / export queries
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct HeatmapCell {
    pub date: String,
    pub hour: i64,
    pub outage_count: i64,
    pub downtime_minutes: f64,
}

pub async fn get_heatmap_data(
    pool: &SqlitePool,
    days: i64,
) -> Result<Vec<HeatmapCell>, sqlx::Error> {
    let from = (Utc::now() - chrono::Duration::days(days)).to_rfc3339();
    sqlx::query_as::<_, HeatmapCell>(
        "SELECT date(started_at) as date,
                CAST(strftime('%H', started_at) AS INTEGER) as hour,
                COUNT(*) as outage_count,
                COALESCE(SUM(duration_s) / 60.0, 0.0) as downtime_minutes
         FROM outages
         WHERE started_at >= ?
         GROUP BY date(started_at), strftime('%H', started_at)
         ORDER BY date, hour",
    )
    .bind(&from)
    .fetch_all(pool)
    .await
}

pub async fn get_outages_in_range(
    pool: &SqlitePool,
    from: &str,
    to: &str,
) -> Result<Vec<Outage>, sqlx::Error> {
    sqlx::query_as::<_, Outage>(
        "SELECT * FROM outages WHERE started_at >= ? AND started_at <= ? ORDER BY started_at",
    )
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await
}

pub async fn get_speed_tests_in_range(
    pool: &SqlitePool,
    from: &str,
    to: &str,
) -> Result<Vec<SpeedTest>, sqlx::Error> {
    sqlx::query_as::<_, SpeedTest>(
        "SELECT * FROM speed_tests WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp",
    )
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await
}

// ---------------------------------------------------------------------------
// Config queries
// ---------------------------------------------------------------------------

pub async fn get_config(pool: &SqlitePool) -> Result<Config, sqlx::Error> {
    sqlx::query_as::<_, Config>("SELECT * FROM config WHERE id = 1")
        .fetch_one(pool)
        .await
}

pub async fn update_config(
    pool: &SqlitePool,
    update: &ConfigUpdate,
) -> Result<Config, sqlx::Error> {
    // Build SET clauses dynamically
    let mut sets = Vec::new();
    if update.targets.is_some() {
        sets.push("targets = ?");
    }
    if update.gateway_ip.is_some() {
        sets.push("gateway_ip = ?");
    }
    if update.ping_interval_s.is_some() {
        sets.push("ping_interval_s = ?");
    }
    if update.outage_threshold.is_some() {
        sets.push("outage_threshold = ?");
    }
    if update.speed_test_cooldown_s.is_some() {
        sets.push("speed_test_cooldown_s = ?");
    }
    if update.speed_test_schedule_s.is_some() {
        sets.push("speed_test_schedule_s = ?");
    }
    if update.auto_speed_test_on_recovery.is_some() {
        sets.push("auto_speed_test_on_recovery = ?");
    }
    if update.data_retention_days.is_some() {
        sets.push("data_retention_days = ?");
    }
    if update.advertised_download_mbps.is_some() {
        sets.push("advertised_download_mbps = ?");
    }
    if update.advertised_upload_mbps.is_some() {
        sets.push("advertised_upload_mbps = ?");
    }

    if sets.is_empty() {
        return get_config(pool).await;
    }

    let sql = format!("UPDATE config SET {} WHERE id = 1", sets.join(", "));

    // Clone update fields for the retry closure
    let targets = update.targets.clone();
    let gateway_ip = update.gateway_ip.clone();
    let ping_interval_s = update.ping_interval_s;
    let outage_threshold = update.outage_threshold;
    let speed_test_cooldown_s = update.speed_test_cooldown_s;
    let speed_test_schedule_s = update.speed_test_schedule_s;
    let auto_speed_test_on_recovery = update.auto_speed_test_on_recovery;
    let data_retention_days = update.data_retention_days;
    let advertised_download_mbps = update.advertised_download_mbps;
    let advertised_upload_mbps = update.advertised_upload_mbps;

    retry(|| {
        let sql = sql.clone();
        let targets = targets.clone();
        let gateway_ip = gateway_ip.clone();
        async move {
            let mut q = sqlx::query(&sql);
            if let Some(ref v) = targets {
                q = q.bind(v);
            }
            if let Some(ref v) = gateway_ip {
                q = q.bind(v);
            }
            if let Some(v) = ping_interval_s {
                q = q.bind(v);
            }
            if let Some(v) = outage_threshold {
                q = q.bind(v);
            }
            if let Some(v) = speed_test_cooldown_s {
                q = q.bind(v);
            }
            if let Some(v) = speed_test_schedule_s {
                q = q.bind(v);
            }
            if let Some(v) = auto_speed_test_on_recovery {
                q = q.bind(v);
            }
            if let Some(v) = data_retention_days {
                q = q.bind(v);
            }
            if let Some(v) = advertised_download_mbps {
                q = q.bind(v);
            }
            if let Some(v) = advertised_upload_mbps {
                q = q.bind(v);
            }
            q.execute(pool).await?;
            Ok(())
        }
    })
    .await?;

    get_config(pool).await
}
