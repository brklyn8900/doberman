use std::time::Duration;

use tokio::process::Command;
use tracing::{info, warn};

/// Run a traceroute to the given target asynchronously.
/// Returns the traceroute output as a string, or an error message on failure.
pub async fn run_traceroute(target: &str) -> String {
    info!("Starting traceroute to {target}");

    let (cmd, args) = if cfg!(target_os = "windows") {
        ("tracert", vec!["-w", "2000", target])
    } else {
        ("traceroute", vec!["-w", "2", "-m", "30", target])
    };

    let result = tokio::time::timeout(Duration::from_secs(30), async {
        Command::new(cmd)
            .args(&args)
            .output()
            .await
    })
    .await;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            if output.status.success() || !stdout.is_empty() {
                info!("Traceroute to {target} completed");
                stdout.to_string()
            } else {
                let msg = format!("Traceroute failed: {stderr}");
                warn!("{msg}");
                msg
            }
        }
        Ok(Err(e)) => {
            let msg = format!("Failed to execute traceroute: {e}");
            warn!("{msg}");
            msg
        }
        Err(_) => {
            let msg = format!("Traceroute to {target} timed out after 30s");
            warn!("{msg}");
            msg
        }
    }
}
