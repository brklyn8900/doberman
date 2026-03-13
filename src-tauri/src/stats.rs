use std::sync::Arc;

use chrono::Utc;
use sqlx::SqlitePool;
use tracing::{error, info};

use crate::db::{self, RollingStat};
use crate::sse::{SseBroadcaster, SseEvent};

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    if sorted.len() == 1 {
        return sorted[0];
    }
    let rank = p / 100.0 * (sorted.len() - 1) as f64;
    let lower = rank.floor() as usize;
    let upper = rank.ceil() as usize;
    if lower == upper {
        sorted[lower]
    } else {
        let frac = rank - lower as f64;
        sorted[lower] * (1.0 - frac) + sorted[upper] * frac
    }
}

fn stddev(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64;
    variance.sqrt()
}

// ---------------------------------------------------------------------------
// Rolling stats computation
// ---------------------------------------------------------------------------

pub async fn compute_rolling_stats(
    pool: &SqlitePool,
    window_seconds: i64,
) -> Result<RollingStat, sqlx::Error> {
    let cutoff = (Utc::now() - chrono::Duration::seconds(window_seconds)).to_rfc3339();
    let now = Utc::now().to_rfc3339();

    // Fetch recent pings within the window
    let rows: Vec<(bool, Option<f64>)> = sqlx::query_as(
        "SELECT success, latency_ms FROM pings WHERE timestamp >= ? ORDER BY timestamp ASC",
    )
    .bind(&cutoff)
    .fetch_all(pool)
    .await?;

    let total = rows.len() as f64;
    let failed = rows.iter().filter(|(s, _)| !s).count() as f64;

    let packet_loss_pct = if total > 0.0 {
        (failed / total) * 100.0
    } else {
        0.0
    };

    // Collect latency values from successful pings
    let mut latencies: Vec<f64> = rows
        .iter()
        .filter(|(s, _)| *s)
        .filter_map(|(_, lat)| *lat)
        .collect();
    latencies.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let avg_latency_ms = if latencies.is_empty() {
        0.0
    } else {
        latencies.iter().sum::<f64>() / latencies.len() as f64
    };

    let jitter_ms = stddev(&latencies);
    let latency_p50 = percentile(&latencies, 50.0);
    let latency_p95 = percentile(&latencies, 95.0);
    let latency_p99 = percentile(&latencies, 99.0);

    Ok(RollingStat {
        id: None,
        timestamp: now,
        window_s: window_seconds,
        packet_loss_pct,
        jitter_ms,
        latency_p50,
        latency_p95,
        latency_p99,
        avg_latency_ms,
    })
}

// ---------------------------------------------------------------------------
// Background stats loop
// ---------------------------------------------------------------------------

pub async fn start_stats_loop(pool: Arc<SqlitePool>, broadcaster: SseBroadcaster) {
    info!("Starting rolling stats loop");

    let mut tick_count: u64 = 0;
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));

    loop {
        interval.tick().await;
        tick_count += 1;

        // Every 30s: compute 5-minute window stats
        match compute_rolling_stats(&pool, 300).await {
            Ok(stat) => {
                if let Err(e) = db::insert_rolling_stat(&pool, &stat).await {
                    error!("Failed to insert 5m rolling stat: {e}");
                }
                broadcaster.send(SseEvent::StatsUpdate {
                    window_s: stat.window_s,
                    packet_loss_pct: stat.packet_loss_pct,
                    jitter_ms: stat.jitter_ms,
                    latency_p50: stat.latency_p50,
                    latency_p95: stat.latency_p95,
                    latency_p99: stat.latency_p99,
                });
            }
            Err(e) => {
                error!("Failed to compute 5m rolling stats: {e}");
            }
        }

        // Every 5 minutes (10 ticks): compute 1h and 24h window stats
        if tick_count % 10 == 0 {
            for window_s in [3600, 86400] {
                match compute_rolling_stats(&pool, window_s).await {
                    Ok(stat) => {
                        if let Err(e) = db::insert_rolling_stat(&pool, &stat).await {
                            error!("Failed to insert {window_s}s rolling stat: {e}");
                        }
                    }
                    Err(e) => {
                        error!("Failed to compute {window_s}s rolling stats: {e}");
                    }
                }
            }
        }
    }
}
