use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};
#[cfg(target_os = "windows")]
use std::io::{Cursor, Read, Write};

use chrono::Utc;
#[cfg(target_os = "windows")]
use reqwest::header::USER_AGENT;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::sync::RwLock;
use tokio::time::Instant;
use tracing::{error, info, warn};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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
    download: f64, // bits per second
    upload: f64,   // bits per second
    ping: f64,     // milliseconds
    server: Option<SpeedTestCliServer>,
}

#[derive(Deserialize)]
struct SpeedTestCliServer {
    sponsor: Option<String>,
    name: Option<String>,
}

/// Run the speedtest CLI and parse its JSON output.
/// Tries Ookla `speedtest` first, falls back to Python `speedtest-cli`.
pub async fn run_speed_test(_app_data_dir: &Path) -> Result<SpeedTestOutput, String> {
    let mut errors = Vec::new();

    #[cfg(target_os = "windows")]
    match ensure_windows_ookla_speedtest(_app_data_dir).await {
        Ok(path) => match run_ookla_speedtest(path.as_os_str()).await {
            Ok(result) => return Ok(result),
            Err(error) => errors.push(format!("Bundled Ookla speedtest failed: {error}")),
        },
        Err(error) => {
            warn!("Bundled Windows speedtest helper unavailable, falling back: {error}");
            errors.push(format!("Bundled Ookla speedtest unavailable: {error}"));
        }
    }

    // Try Ookla speedtest on PATH first
    match run_ookla_speedtest("speedtest").await {
        Ok(result) => return Ok(result),
        Err(error) => errors.push(format!("PATH speedtest failed: {error}")),
    }

    // Fall back to speedtest-cli (Python)
    match run_speedtest_cli("speedtest-cli").await {
        Ok(result) => Ok(result),
        Err(error) => {
            errors.push(format!("PATH speedtest-cli failed: {error}"));
            Err(errors.join(" | "))
        }
    }
}

async fn run_ookla_speedtest(command: impl AsRef<OsStr>) -> Result<SpeedTestOutput, String> {
    let mut process = tokio::process::Command::new(command);
    process.args(["--format=json", "--accept-license", "--accept-gdpr"]);
    hide_child_console_window(&mut process);

    let output = tokio::time::timeout(
        Duration::from_secs(120),
        process.output(),
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

async fn run_speedtest_cli(command: impl AsRef<OsStr>) -> Result<SpeedTestOutput, String> {
    let mut process = tokio::process::Command::new(command);
    process.args(["--json"]);
    hide_child_console_window(&mut process);

    let output = tokio::time::timeout(
        Duration::from_secs(120),
        process.output(),
    )
    .await
    .map_err(|_| "Speed test timed out after 120 seconds".to_string())?
    .map_err(|e| format!("Failed to execute speedtest-cli: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "speedtest-cli exited with {}: {stderr}",
            output.status
        ));
    }

    let json: SpeedTestCliJson = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse speedtest-cli JSON: {e}"))?;

    let bits_to_mbps = |b: f64| b / 1_000_000.0;
    let server_name = json.server.and_then(|s| s.sponsor.or(s.name));

    Ok(SpeedTestOutput {
        download_mbps: bits_to_mbps(json.download),
        upload_mbps: bits_to_mbps(json.upload),
        ping_ms: json.ping,
        server_name,
    })
}

#[cfg(target_os = "windows")]
fn hide_child_console_window(command: &mut tokio::process::Command) {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_child_console_window(_command: &mut tokio::process::Command) {}

#[cfg(target_os = "windows")]
const WINDOWS_OOKLA_SPEEDTEST_URL: &str =
    "https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-win64.zip";

#[cfg(target_os = "windows")]
async fn ensure_windows_ookla_speedtest(app_data_dir: &Path) -> Result<PathBuf, String> {
    let install_dir = app_data_dir.join("tools").join("ookla-speedtest");
    let exe_path = install_dir.join("speedtest.exe");

    if exe_path.exists() {
        return Ok(exe_path);
    }

    info!(
        "speedtest.exe not found; downloading Ookla CLI to {}",
        exe_path.display()
    );

    let client = reqwest::Client::new();
    let response = tokio::time::timeout(
        Duration::from_secs(60),
        client
            .get(WINDOWS_OOKLA_SPEEDTEST_URL)
            .header(USER_AGENT, "Doberman/0.1.0")
            .send(),
    )
    .await
    .map_err(|_| "Timed out downloading Ookla speedtest CLI".to_string())?
    .map_err(|e| format!("Failed to download Ookla speedtest CLI: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download Ookla speedtest CLI: HTTP {}",
            response.status()
        ));
    }

    let archive = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read Ookla speedtest CLI download: {e}"))?;

    let install_dir_for_extract = install_dir.clone();
    let exe_path_for_extract = exe_path.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&install_dir_for_extract)
            .map_err(|e| format!("Failed to create speed test install directory: {e}"))?;

        let mut zip = zip::ZipArchive::new(Cursor::new(archive))
            .map_err(|e| format!("Failed to open Ookla speedtest archive: {e}"))?;

        let mut entry = zip
            .by_name("speedtest.exe")
            .map_err(|e| format!("Ookla speedtest archive did not contain speedtest.exe: {e}"))?;

        let temp_path = exe_path_for_extract.with_extension("exe.download");
        let mut output = std::fs::File::create(&temp_path)
            .map_err(|e| format!("Failed to create speedtest.exe temp file: {e}"))?;

        let mut buffer = Vec::new();
        entry
            .read_to_end(&mut buffer)
            .map_err(|e| format!("Failed to extract speedtest.exe: {e}"))?;
        output
            .write_all(&buffer)
            .map_err(|e| format!("Failed to write speedtest.exe: {e}"))?;
        output
            .flush()
            .map_err(|e| format!("Failed to flush speedtest.exe: {e}"))?;

        std::fs::rename(&temp_path, &exe_path_for_extract)
            .map_err(|e| format!("Failed to finalize speedtest.exe: {e}"))?;

        Ok::<_, String>(exe_path_for_extract)
    })
    .await
    .map_err(|e| format!("Failed to finish speedtest.exe install task: {e}"))?
}

// ---------------------------------------------------------------------------
// SpeedTestManager
// ---------------------------------------------------------------------------

pub struct SpeedTestManager {
    last_test_time: tokio::sync::Mutex<Option<Instant>>,
    is_running: Arc<AtomicBool>,
    app_data_dir: PathBuf,
}

impl SpeedTestManager {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            last_test_time: tokio::sync::Mutex::new(None),
            is_running: Arc::new(AtomicBool::new(false)),
            app_data_dir,
        }
    }

    /// Check if a speed test can be started (cooldown elapsed and not already running).
    pub async fn can_run(&self, cooldown_s: u64) -> bool {
        if self.is_running.load(Ordering::SeqCst) {
            return false;
        }
        let last = self.last_test_time.lock().await;
        match *last {
            Some(t) => t.elapsed() >= Duration::from_secs(cooldown_s),
            None => true,
        }
    }

    /// Trigger a speed test, insert the result into the DB, and broadcast SSE events.
    /// Returns the inserted test row.
    pub async fn trigger_test(
        &self,
        pool: &SqlitePool,
        broadcaster: &SseBroadcaster,
        cooldown_s: u64,
        trigger_type: &str,
        outage_id: Option<i64>,
    ) -> Result<SpeedTest, String> {
        if !self.can_run(cooldown_s).await {
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

        let result = run_speed_test(&self.app_data_dir).await;

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

        Ok(SpeedTest {
            id: Some(test_id),
            ..test
        })
    }
}

// ---------------------------------------------------------------------------
// Scheduled speed test loop
// ---------------------------------------------------------------------------

pub async fn start_scheduled_speed_test_loop(
    pool: Arc<SqlitePool>,
    broadcaster: SseBroadcaster,
    config: Arc<RwLock<Config>>,
    manager: Arc<SpeedTestManager>,
) {
    loop {
        let (schedule_s, cooldown_s) = {
            let cfg = config.read().await;
            (
                cfg.speed_test_schedule_s as u64,
                cfg.speed_test_cooldown_s as u64,
            )
        };

        tokio::time::sleep(Duration::from_secs(schedule_s)).await;

        if !manager.can_run(cooldown_s).await {
            warn!("Scheduled speed test skipped — cooldown active or test already running");
            continue;
        }

        if let Err(e) = manager
            .trigger_test(&pool, &broadcaster, cooldown_s, "scheduled", None)
            .await
        {
            error!("Scheduled speed test failed: {e}");
        }
    }
}
