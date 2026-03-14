use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use chrono::Local;
use tauri::{AppHandle, Manager};
use tracing::{info, warn};

#[cfg(target_os = "macos")]
#[path = "notifications_macos.rs"]
mod macos_backend;

#[cfg(not(target_os = "macos"))]
use notify_rust::Notification;

#[cfg(target_os = "windows")]
const WINDOWS_APP_ID: &str = "io.armana.doberman";

#[cfg(not(target_os = "macos"))]
fn build_notification(summary: &str, body: &str) -> Notification {
    let mut notification = Notification::new();
    notification.summary(summary).body(body);

    #[cfg(target_os = "windows")]
    notification.app_id(WINDOWS_APP_ID);

    notification
}

pub fn send_notification(summary: &str, body: &str) -> Result<(), String> {
    info!("sending notification: {summary} | {body}");

    #[cfg(target_os = "macos")]
    {
        macos_backend::send_notification(summary, body)
    }

    #[cfg(not(target_os = "macos"))]
    {
        build_notification(summary, body)
            .show()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

fn notification_debug_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create app data dir: {e}"))?;
    Ok(dir.join("notification-debug.log"))
}

fn append_notification_debug_log(app: &AppHandle, message: &str) {
    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{timestamp}] {message}\n");
    info!("{message}");

    let Ok(path) = notification_debug_log_path(app) else {
        warn!("failed to resolve notification debug log path");
        return;
    };

    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut file) => {
            let _ = file.write_all(line.as_bytes());
        }
        Err(err) => {
            warn!(
                "failed to append notification debug log at {}: {err}",
                path.display()
            );
        }
    }
}

#[tauri::command]
pub fn send_test_notification(app: AppHandle) -> Result<String, String> {
    let sent_at = Local::now().format("%H:%M:%S").to_string();
    let log_path = notification_debug_log_path(&app)?;

    append_notification_debug_log(
        &app,
        &format!(
            "test notification requested (platform={}, log={})",
            std::env::consts::OS,
            log_path.display()
        ),
    );

    append_notification_debug_log(&app, "attempting test notification send");

    match send_notification(
        "Doberman — Test Notification",
        &format!("Desktop notifications are enabled. Sent at {sent_at}."),
    ) {
        Ok(()) => append_notification_debug_log(&app, "test notification send returned Ok"),
        Err(err) => {
            append_notification_debug_log(
                &app,
                &format!("test notification send returned Err: {err}"),
            );
            return Err(err);
        }
    }

    Ok(log_path.display().to_string())
}
