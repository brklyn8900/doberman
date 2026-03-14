use std::sync::Arc;

use chrono::Utc;
use sqlx::SqlitePool;
use tracing::{info, warn};

use crate::db;
use crate::notifications;
use crate::ping::PingResult;
use crate::sse::{SseBroadcaster, SseEvent};
use crate::traceroute;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn format_duration_short(secs: f64) -> String {
    let total = secs as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    if h > 0 {
        format!("{h}h {m}m {s}s")
    } else if m > 0 {
        format!("{m}m {s}s")
    } else {
        format!("{s}s")
    }
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Up,
    Down,
}

pub struct OutageDetector {
    state: ConnectionState,
    consecutive_failure_count: usize,
    current_outage_id: Option<i64>,
    outage_threshold: usize,
}

impl OutageDetector {
    pub fn new(outage_threshold: i64) -> Self {
        Self {
            state: ConnectionState::Up,
            consecutive_failure_count: 0,
            current_outage_id: None,
            outage_threshold: outage_threshold.max(1) as usize,
        }
    }

    /// Update the outage threshold (e.g. when config changes).
    pub fn set_threshold(&mut self, threshold: i64) {
        self.outage_threshold = threshold.max(1) as usize;
    }

    /// Process a round of ping results and handle state transitions.
    pub async fn process_ping_round(
        &mut self,
        results: &[PingResult],
        pool: &Arc<SqlitePool>,
        broadcaster: &SseBroadcaster,
        notify_on_outage: bool,
        notify_on_recovery: bool,
    ) {
        match self.state {
            ConnectionState::Up => {
                self.handle_up(results, pool, broadcaster, notify_on_outage)
                    .await
            }
            ConnectionState::Down => {
                self.handle_down(results, pool, broadcaster, notify_on_recovery)
                    .await
            }
        }
    }

    async fn handle_up(
        &mut self,
        results: &[PingResult],
        pool: &Arc<SqlitePool>,
        broadcaster: &SseBroadcaster,
        notify_on_outage: bool,
    ) {
        // Count how many non-gateway targets failed
        let non_gateway_failed: Vec<&PingResult> = results
            .iter()
            .filter(|r| !r.is_gateway && !r.success)
            .collect();

        if non_gateway_failed.len() >= 2 {
            self.consecutive_failure_count += 1;
            info!(
                "Failure round {}/{} — {} non-gateway targets down",
                self.consecutive_failure_count,
                self.outage_threshold,
                non_gateway_failed.len()
            );

            if self.consecutive_failure_count >= self.outage_threshold {
                self.transition_to_down(
                    results,
                    &non_gateway_failed,
                    pool,
                    broadcaster,
                    notify_on_outage,
                )
                .await;
            }
        } else {
            // Reset on any passing round
            if self.consecutive_failure_count > 0 {
                info!("Failure count reset (not enough targets failed this round)");
            }
            self.consecutive_failure_count = 0;
        }
    }

    async fn transition_to_down(
        &mut self,
        results: &[PingResult],
        failed: &[&PingResult],
        pool: &Arc<SqlitePool>,
        broadcaster: &SseBroadcaster,
        notify_on_outage: bool,
    ) {
        let now = Utc::now();

        // Determine cause
        let gateway_result = results.iter().find(|r| r.is_gateway);
        let cause = match gateway_result {
            Some(gw) if !gw.success => "local",
            Some(_) => "isp",
            None => "unknown",
        };

        let targets_down: Vec<String> = failed.iter().map(|r| r.target.clone()).collect();

        info!(
            "OUTAGE DETECTED — cause={cause}, targets_down={:?}",
            targets_down
        );

        // Insert outage record
        match db::insert_outage(pool, &now, cause, &targets_down).await {
            Ok(outage_id) => {
                self.current_outage_id = Some(outage_id);
                self.state = ConnectionState::Down;

                let started_at = now.to_rfc3339();

                // Broadcast outage_start
                broadcaster.send(SseEvent::OutageStart {
                    outage_id,
                    started_at: started_at.clone(),
                    targets_down: targets_down.clone(),
                    cause: cause.to_string(),
                });

                // Broadcast status_change
                broadcaster.send(SseEvent::StatusChange {
                    status: "down".to_string(),
                    timestamp: started_at,
                });

                // Desktop notification for outage start
                let time_str = now.format("%H:%M:%S").to_string();
                let notif_body = format!("Outage detected at {} — cause: {}", time_str, cause);
                if notify_on_outage {
                    if let Err(e) =
                        notifications::send_notification("Doberman — Internet Outage", &notif_body)
                    {
                        warn!("Failed to send outage notification: {e}");
                    }
                }

                // Fire async traceroute (don't block the ping loop)
                let pool_clone = pool.clone();
                let first_target = targets_down
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "8.8.8.8".to_string());
                tokio::spawn(async move {
                    let trace_output = traceroute::run_traceroute(&first_target).await;
                    if let Err(e) =
                        db::update_outage_traceroute(&pool_clone, outage_id, &trace_output).await
                    {
                        warn!("Failed to store traceroute for outage {outage_id}: {e}");
                    }
                });
            }
            Err(e) => {
                warn!("Failed to insert outage record: {e}");
            }
        }
    }

    async fn handle_down(
        &mut self,
        results: &[PingResult],
        pool: &Arc<SqlitePool>,
        broadcaster: &SseBroadcaster,
        notify_on_recovery: bool,
    ) {
        // If any non-gateway target succeeds, transition back to UP
        let any_non_gateway_success = results.iter().any(|r| !r.is_gateway && r.success);

        if any_non_gateway_success {
            self.transition_to_up(pool, broadcaster, notify_on_recovery)
                .await;
        }
    }

    async fn transition_to_up(
        &mut self,
        pool: &Arc<SqlitePool>,
        broadcaster: &SseBroadcaster,
        notify_on_recovery: bool,
    ) {
        let now = Utc::now();
        let ended_at = now.to_rfc3339();

        if let Some(outage_id) = self.current_outage_id.take() {
            info!("OUTAGE ENDED — outage_id={outage_id}");

            match db::close_outage(pool, outage_id, &now).await {
                Ok(()) => {
                    // Fetch the closed outage to get started_at and duration
                    let duration_s = match db::get_outage_by_id(pool, outage_id).await {
                        Ok(Some(outage)) => outage.duration_s.unwrap_or(0.0),
                        _ => 0.0,
                    };
                    let started_at = match db::get_outage_by_id(pool, outage_id).await {
                        Ok(Some(outage)) => outage.started_at,
                        _ => ended_at.clone(),
                    };

                    broadcaster.send(SseEvent::OutageEnd {
                        outage_id,
                        started_at,
                        ended_at: ended_at.clone(),
                        duration_s,
                    });

                    // Desktop notification for outage end
                    let dur_human = format_duration_short(duration_s);
                    let notif_body = format!("Internet restored after {dur_human}");
                    if notify_on_recovery {
                        if let Err(e) = notifications::send_notification(
                            "Doberman — Connection Restored",
                            &notif_body,
                        ) {
                            warn!("Failed to send recovery notification: {e}");
                        }
                    }
                }
                Err(e) => {
                    warn!("Failed to close outage {outage_id}: {e}");
                }
            }

            // TODO: trigger recovery speed test (speed_test.rs comes later)
            info!("Recovery speed test would be triggered here (not yet implemented)");
        }

        // Broadcast status_change
        broadcaster.send(SseEvent::StatusChange {
            status: "up".to_string(),
            timestamp: ended_at,
        });

        self.state = ConnectionState::Up;
        self.consecutive_failure_count = 0;
    }
}
