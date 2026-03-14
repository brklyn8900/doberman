use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::sync::RwLock;
use tokio::time::Instant;
use tracing::{error, info, warn};

use crate::db::{self, Config, SpeedTest};
use crate::sse::{SseBroadcaster, SseEvent};

// ---------------------------------------------------------------------------
// Speed test output (parsed from speedtest CLI JSON)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeedTestOutput {
    pub download_mbps: f64,
    pub upload_mbps: f64,
    pub ping_ms: f64,
    pub server_name: Option<String>,
}

/// Ookla speedtest --format=json output
#[derive(Deserialize)]
struct OoklaJson {
    download: OoklaBandwidth,
    upload: OoklaBandwidth,
    ping: OoklaPing,
    server: Option<OoklaServer>,
}

#[derive(Deserialize)]
struct OoklaBandwidth {
    bandwidth: f64, // bytes per second
}

#[derive(Deserialize)]
struct OoklaPing {
    latency: f64,
}

#[derive(Deserialize)]
struct OoklaServer {
    name: Option<String>,
}

/// speedtest-cli --json output (Python version)
#[derive(Deserialize)]
struct SpeedTestCliJson {
    download: f64,  // bits per second
    upload: f64,    // bits per second
    ping: f64,      // milliseconds
    server: Option<SpeedTestCliServer>,
}

#[derive(Deserialize)]
struct SpeedTestCliServer {
    sponsor: Option<String>,
    name: Option<String>,
}

/// Run the speedtest CLI and parse its JSON output.
/// Tries Ookla `speedtest` first, falls back to Python `speedtest-cli`.
pub async fn run_speed_test() -> Result<SpeedTestOutput, String> {
    // Try Ookla speedtest first
    if let Ok(result) = run_ookla_speedtest().await {
        return Ok(result);
    }

    // Fall back to speedtest-cli (Python)
    run_speedtest_cli().await
}

async fn run_ookla_speedtest() -> Result<SpeedTestOutput, String> {
    let output = tokio::time::timeout(
        Duration::from_secs(120),
        tokio::process::Command::new("speedtest")
            .args(["--format=json", "--accept-license", "--accept-gdpr"])
            .output(),
    )
    .await
    .map_err(|_| "Timed out".to_string())?
    .map_err(|e| format!("Failed to execute speedtest: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("speedtest exited with {}: {stderr}", output.status));
    }

    let json: OoklaJson = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse Ookla JSON: {e}"))?;

    let bytes_to_mbps = |b: f64| (b * 8.0) / 1_000_000.0;

    Ok(SpeedTestOutput {
        download_mbps: bytes_to_mbps(json.download.bandwidth),
        upload_mbps: bytes_to_mbps(json.upload.bandwidth),
        ping_ms: json.ping.latency,
        server_name: json.server.and_then(|s| s.name),
    })
}

async fn run_speedtest_cli() -> Result<SpeedTestOutput, String> {
    let output = tokio::time::timeout(
        Duration::from_secs(120),
        tokio::process::Command::new("speedtest-cli")
            .args(["--json"])
            .output(),
    )
    .await
    .map_err(|_| "Speed test timed out after 120 seconds".to_string())?
    .map_err(|e| format!("Failed to execute speedtest-cli: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("speedtest-cli exited with {}: {stderr}", output.status));
    }

    let json: SpeedTestCliJson = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse speedtest-cli JSON: {e}"))?;

    let bits_to_mbps = |b: f64| b / 1_000_000.0;
    let server_name = json.server.and_then(|s| {
        s.sponsor.or(s.name)
    });

    Ok(SpeedTestOutput {
        download_mbps: bits_to_mbps(json.download),
        upload_mbps: bits_to_mbps(json.upload),
        ping_ms: json.ping,
        server_name,
    })
}

// ---------------------------------------------------------------------------
// SpeedTestManager
// ---------------------------------------------------------------------------

pub struct SpeedTestManager {
    last_test_time: tokio::sync::Mutex<Option<Instant>>,
    cooldown_s: u64,
    is_running: Arc<AtomicBool>,
}

impl SpeedTestManager {
    pub fn new(cooldown_s: u64) -> Self {
        Self {
            last_test_time: tokio::sync::Mutex::new(None),
            cooldown_s,
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Check if a speed test can be started (cooldown elapsed and not already running).
    pub async fn can_run(&self) -> bool {
        if self.is_running.load(Ordering::SeqCst) {
            return false;
        }
        let last = self.last_test_time.lock().await;
        match *last {
            Some(t) => t.elapsed() >= Duration::from_secs(self.cooldown_s),
            None => true,
        }
    }

    /// Trigger a speed test, insert the result into the DB, and broadcast SSE events.
    /// Returns the inserted test row ID.
    pub async fn trigger_test(
        &self,
        pool: &SqlitePool,
        broadcaster: &SseBroadcaster,
        trigger_type: &str,
        outage_id: Option<i64>,
    ) -> Result<i64, String> {
        if !self.can_run().await {
            return Err("Speed test on cooldown or already running".to_string());
        }

        // Mark as running (compare-and-swap to avoid races)
        if self
            .is_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("Speed test already running".to_string());
        }

        // Use a placeholder test_id of 0 for the start event since we don't have one yet
        broadcaster.send(SseEvent::SpeedTestStart {
            test_id: 0,
            trigger: trigger_type.to_string(),
            timestamp: Utc::now().to_rfc3339(),
        });

        info!("Starting speed test (trigger: {trigger_type})");

        let result = run_speed_test().await;

        // Always clear the running flag and update last_test_time
        self.is_running.store(false, Ordering::SeqCst);
        *self.last_test_time.lock().await = Some(Instant::now());

        let output = result?;

        let test = SpeedTest {
            id: None,
            timestamp: Utc::now().to_rfc3339(),
            download_mbps: output.download_mbps,
            upload_mbps: output.upload_mbps,
            ping_ms: output.ping_ms,
            server_name: output.server_name,
            trigger_type: trigger_type.to_string(),
            outage_id,
        };

        let test_id = db::insert_speed_test(pool, &test)
            .await
            .map_err(|e| format!("Failed to insert speed test result: {e}"))?;

        info!(
            "Speed test complete: {:.1} Mbps down, {:.1} Mbps up, {:.1} ms ping",
            test.download_mbps, test.upload_mbps, test.ping_ms
        );

        broadcaster.send(SseEvent::SpeedTestResult {
            id: test_id,
            timestamp: test.timestamp.clone(),
            download_mbps: test.download_mbps,
            upload_mbps: test.upload_mbps,
            ping_ms: test.ping_ms,
            server_name: test.server_name.clone(),
            trigger: test.trigger_type.clone(),
        });

        Ok(test_id)
    }
}

// ---------------------------------------------------------------------------
// Scheduled speed test loop
// ---------------------------------------------------------------------------

pub async fn start_scheduled_speed_test_loop(
    pool: Arc<SqlitePool>,
    broadcaster: SseBroadcaster,
    config: Arc<RwLock<Config>>,
) {
    // Read initial config for cooldown and schedule interval
    let cooldown_s = {
        let cfg = config.read().await;
        cfg.speed_test_cooldown_s as u64
    };

    let manager = SpeedTestManager::new(cooldown_s);

    loop {
        // Re-read schedule interval each iteration in case config changed
        let schedule_s = {
            let cfg = config.read().await;
            cfg.speed_test_schedule_s as u64
        };

        tokio::time::sleep(Duration::from_secs(schedule_s)).await;

        if !manager.can_run().await {
            warn!("Scheduled speed test skipped — cooldown active or test already running");
            continue;
        }

        if let Err(e) = manager
            .trigger_test(&pool, &broadcaster, "scheduled", None)
            .await
        {
            error!("Scheduled speed test failed: {e}");
        }
    }
}
