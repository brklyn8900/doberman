use axum::{
    extract::State,
    response::sse::{Event, KeepAlive, Sse},
};
use futures_core::Stream;
use serde::Serialize;
use std::{convert::Infallible, sync::Arc};
use tokio::sync::broadcast;
use tokio_stream::{wrappers::BroadcastStream, StreamExt};

// ---------------------------------------------------------------------------
// SSE Event types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SseEvent {
    PingResult {
        target: String,
        success: bool,
        latency_ms: Option<f64>,
        dns_ms: Option<f64>,
        timestamp: String,
    },
    OutageStart {
        outage_id: i64,
        started_at: String,
        targets_down: Vec<String>,
        cause: String,
    },
    OutageEnd {
        outage_id: i64,
        started_at: String,
        ended_at: String,
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
        timestamp: String,
    },
    SpeedTestResult {
        id: i64,
        timestamp: String,
        download_mbps: f64,
        upload_mbps: f64,
        ping_ms: f64,
        server_name: Option<String>,
        trigger: String,
    },
    StatusChange {
        status: String,
        timestamp: String,
    },
}

impl SseEvent {
    /// Returns the SSE event name (used as the `event:` field).
    fn event_name(&self) -> &'static str {
        match self {
            Self::PingResult { .. } => "ping_result",
            Self::OutageStart { .. } => "outage_start",
            Self::OutageEnd { .. } => "outage_end",
            Self::StatsUpdate { .. } => "stats_update",
            Self::SpeedTestStart { .. } => "speed_test_start",
            Self::SpeedTestResult { .. } => "speed_test_result",
            Self::StatusChange { .. } => "status_change",
        }
    }
}

// ---------------------------------------------------------------------------
// Broadcaster
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct SseBroadcaster {
    tx: Arc<broadcast::Sender<SseEvent>>,
}

impl SseBroadcaster {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { tx: Arc::new(tx) }
    }

    /// Broadcast an event to all connected SSE clients.
    /// Silently ignores errors when there are no active receivers.
    pub fn send(&self, event: SseEvent) {
        let _ = self.tx.send(event);
    }

    /// Create a new receiver for SSE events.
    pub fn subscribe(&self) -> broadcast::Receiver<SseEvent> {
        self.tx.subscribe()
    }
}

// ---------------------------------------------------------------------------
// Axum SSE handler
// ---------------------------------------------------------------------------

pub async fn sse_handler(
    State(broadcaster): State<SseBroadcaster>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = broadcaster.subscribe();

    let stream = BroadcastStream::new(rx).filter_map(|result| match result {
        Ok(event) => {
            let data = serde_json::to_string(&event).unwrap_or_default();
            Some(Ok(Event::default().event(event.event_name()).data(data)))
        }
        Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(n)) => {
            tracing::warn!("SSE client lagged, skipped {n} events");
            None
        }
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}
