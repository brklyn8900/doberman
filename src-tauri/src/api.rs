use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

use crate::db::{self, Config, OutageQueryParams, PingQueryParams};
use crate::speed_test::SpeedTestManager;
use crate::sse::{self, SseBroadcaster};

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<SqlitePool>,
    pub broadcaster: SseBroadcaster,
    pub config: Arc<RwLock<Config>>,
    pub speed_test_manager: Arc<SpeedTestManager>,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn create_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/status", get(get_status))
        .route("/api/pings", get(get_pings))
        .route("/api/outages", get(get_outages))
        .route("/api/outages/{id}", get(get_outage))
        .route("/api/stats", get(get_stats))
        .route("/api/stats/summary", get(get_stats_summary))
        .route("/api/speed-tests", get(get_speed_tests))
        .route("/api/speed-tests/run", post(run_speed_test))
        .route("/api/speed-tests/{id}", get(get_speed_test))
        .route("/api/config", get(get_config).put(put_config))
        .route("/api/events", get(sse_events))
        .route("/api/heatmap", get(get_heatmap))
        .route("/api/export/csv", get(export_csv))
        .route("/api/export/report", get(export_report))
        .layer(cors)
        .with_state(state)
}

// ---------------------------------------------------------------------------
// GET /api/status
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct StatusResponse {
    status: String,
    active_outage: Option<db::Outage>,
    last_pings: Vec<db::PingRecord>,
    icmp_mode: String,
}

async fn get_status(State(state): State<AppState>) -> Result<Json<StatusResponse>, AppError> {
    let active_outage = db::get_active_outage(&state.db).await?;
    let last_pings = db::get_last_ping_per_target(&state.db).await?;

    let status = if active_outage.is_some() {
        "down"
    } else {
        "up"
    };

    Ok(Json(StatusResponse {
        status: status.to_string(),
        active_outage,
        last_pings,
        icmp_mode: "tcp".to_string(),
    }))
}

// ---------------------------------------------------------------------------
// GET /api/pings
// ---------------------------------------------------------------------------

async fn get_pings(
    State(state): State<AppState>,
    Query(params): Query<PingQueryParams>,
) -> Result<impl IntoResponse, AppError> {
    let pings = db::get_pings(&state.db, &params).await?;
    let total = pings.len();
    Ok(Json(serde_json::json!({ "pings": pings, "total": total })))
}

// ---------------------------------------------------------------------------
// GET /api/outages
// ---------------------------------------------------------------------------

async fn get_outages(
    State(state): State<AppState>,
    Query(params): Query<OutageQueryParams>,
) -> Result<impl IntoResponse, AppError> {
    let outages = db::get_outages(&state.db, &params).await?;
    Ok(Json(serde_json::json!({ "outages": outages })))
}

// ---------------------------------------------------------------------------
// GET /api/outages/:id
// ---------------------------------------------------------------------------

async fn get_outage(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    match db::get_outage_by_id(&state.db, id).await? {
        Some(outage) => Ok(Json(outage).into_response()),
        None => Ok(StatusCode::NOT_FOUND.into_response()),
    }
}

// ---------------------------------------------------------------------------
// GET /api/stats?window=300
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct StatsQuery {
    #[allow(dead_code)]
    window: Option<i64>,
}

async fn get_stats(
    State(state): State<AppState>,
    Query(_params): Query<StatsQuery>,
) -> Result<impl IntoResponse, AppError> {
    match db::get_latest_stats(&state.db).await? {
        Some(stat) => Ok(Json(stat).into_response()),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

// ---------------------------------------------------------------------------
// GET /api/stats/summary
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct StatsSummaryResponse {
    uptime_1h: f64,
    uptime_24h: f64,
    uptime_7d: f64,
    mtbf_s: Option<f64>,
    mttr_s: Option<f64>,
    outage_count_today: i64,
    jitter_ms: f64,
    packet_loss_pct: f64,
    latency_p95: f64,
}

async fn get_stats_summary(
    State(state): State<AppState>,
) -> Result<Json<StatsSummaryResponse>, AppError> {
    async fn window_stats(
        db: &sqlx::SqlitePool,
        window_s: i64,
    ) -> Result<(f64, Option<f64>, Option<f64>, i64), sqlx::Error> {
        let from = (chrono::Utc::now() - chrono::Duration::seconds(window_s)).to_rfc3339();
        let params = OutageQueryParams {
            from: Some(from),
            to: None,
            cause: None,
            limit: Some(500),
        };
        let outages = db::get_outages(db, &params).await?;
        let count = outages.len() as i64;
        let total_s: f64 = outages.iter().filter_map(|o| o.duration_s).sum();
        let uptime = ((1.0 - total_s / window_s as f64) * 100.0).clamp(0.0, 100.0);
        let mtbf = if count > 0 {
            Some(window_s as f64 / count as f64)
        } else {
            None
        };
        let closed: Vec<f64> = outages.iter().filter_map(|o| o.duration_s).collect();
        let mttr = if closed.is_empty() {
            None
        } else {
            Some(closed.iter().sum::<f64>() / closed.len() as f64)
        };
        Ok((uptime, mtbf, mttr, count))
    }

    let (uptime_1h, _, _, _) = window_stats(&state.db, 3_600).await?;
    let (uptime_24h, mtbf_s, mttr_s, outage_count_today) =
        window_stats(&state.db, 86_400).await?;
    let (uptime_7d, _, _, _) = window_stats(&state.db, 604_800).await?;

    let latest_stat = db::get_latest_stats(&state.db).await?;

    Ok(Json(StatsSummaryResponse {
        uptime_1h,
        uptime_24h,
        uptime_7d,
        mtbf_s,
        mttr_s,
        outage_count_today,
        jitter_ms: latest_stat.as_ref().map(|s| s.jitter_ms).unwrap_or(0.0),
        packet_loss_pct: latest_stat
            .as_ref()
            .map(|s| s.packet_loss_pct)
            .unwrap_or(0.0),
        latency_p95: latest_stat.as_ref().map(|s| s.latency_p95).unwrap_or(0.0),
    }))
}

// ---------------------------------------------------------------------------
// GET /api/speed-tests
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SpeedTestQuery {
    #[allow(dead_code)]
    from: Option<String>,
    #[allow(dead_code)]
    to: Option<String>,
    #[allow(dead_code)]
    trigger: Option<String>,
    limit: Option<i64>,
}

async fn get_speed_tests(
    State(state): State<AppState>,
    Query(params): Query<SpeedTestQuery>,
) -> Result<impl IntoResponse, AppError> {
    let tests = db::get_speed_tests(&state.db, params.limit).await?;
    Ok(Json(serde_json::json!({ "tests": tests })))
}

// ---------------------------------------------------------------------------
// POST /api/speed-tests/run
// ---------------------------------------------------------------------------

async fn run_speed_test(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    let config = state.config.read().await;
    let cooldown_s = config.speed_test_cooldown_s as u64;
    drop(config);

    match state
        .speed_test_manager
        .trigger_test(
            state.db.as_ref(),
            &state.broadcaster,
            cooldown_s,
            "manual",
            None,
        )
        .await
    {
        Ok(test) => Ok((StatusCode::OK, Json(test)).into_response()),
        Err(error) if error.contains("cooldown") || error.contains("already running") => Ok((
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({
                "error": error,
                "cooldown_s": cooldown_s,
            })),
        )
            .into_response()),
        Err(error) => Ok((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response()),
    }
}

// ---------------------------------------------------------------------------
// GET /api/speed-tests/:id
// ---------------------------------------------------------------------------

async fn get_speed_test(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    match db::get_speed_test_by_id(&state.db, id).await? {
        Some(test) => Ok(Json(test).into_response()),
        None => Ok(StatusCode::NOT_FOUND.into_response()),
    }
}

// ---------------------------------------------------------------------------
// GET /api/config
// ---------------------------------------------------------------------------

async fn get_config(State(state): State<AppState>) -> Result<Json<Config>, AppError> {
    let config = db::get_config(&state.db).await?;
    Ok(Json(config))
}

// ---------------------------------------------------------------------------
// PUT /api/config
// ---------------------------------------------------------------------------

async fn put_config(
    State(state): State<AppState>,
    Json(update): Json<db::ConfigUpdate>,
) -> Result<Json<Config>, AppError> {
    let updated = db::update_config(&state.db, &update).await?;

    // Update the shared config so the ping loop picks up changes immediately
    {
        let mut cfg = state.config.write().await;
        *cfg = updated.clone();
    }

    Ok(Json(updated))
}

// ---------------------------------------------------------------------------
// GET /api/events (SSE)
// ---------------------------------------------------------------------------

async fn sse_events(
    State(state): State<AppState>,
) -> impl IntoResponse {
    sse::sse_handler(State(state.broadcaster)).await
}

// ---------------------------------------------------------------------------
// GET /api/heatmap?days=7
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct HeatmapQuery {
    days: Option<i64>,
}

async fn get_heatmap(
    State(state): State<AppState>,
    Query(params): Query<HeatmapQuery>,
) -> Result<impl IntoResponse, AppError> {
    let days = params.days.unwrap_or(7).max(1).min(90);
    let cells = db::get_heatmap_data(&state.db, days).await?;
    Ok(Json(serde_json::json!({ "cells": cells })))
}

// ---------------------------------------------------------------------------
// GET /api/export/csv?from=&to=
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ExportQuery {
    from: String,
    to: String,
}

fn format_duration_human(secs: f64) -> String {
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

async fn export_csv(
    State(state): State<AppState>,
    Query(params): Query<ExportQuery>,
) -> Result<impl IntoResponse, AppError> {
    let outages = db::get_outages_in_range(&state.db, &params.from, &params.to).await?;

    let mut csv = String::from("Start Time,End Time,Duration (seconds),Duration (human),Cause,Targets Down\n");
    for o in &outages {
        let ended = o.ended_at.as_deref().unwrap_or("ongoing");
        let dur_s = o.duration_s.unwrap_or(0.0);
        let dur_h = format_duration_human(dur_s);
        // Escape CSV fields that might contain commas/quotes
        let cause = o.cause.replace('"', "\"\"");
        let targets = o.targets_down.replace('"', "\"\"");
        csv.push_str(&format!(
            "{},{},{:.1},{},\"{}\",\"{}\"\n",
            o.started_at, ended, dur_s, dur_h, cause, targets
        ));
    }

    let headers = [
        (header::CONTENT_TYPE, "text/csv"),
        (
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"doberman-outages.csv\"",
        ),
    ];
    Ok((headers, csv))
}

// ---------------------------------------------------------------------------
// GET /api/export/report?from=&to=
// ---------------------------------------------------------------------------

async fn export_report(
    State(state): State<AppState>,
    Query(params): Query<ExportQuery>,
) -> Result<impl IntoResponse, AppError> {
    let outages = db::get_outages_in_range(&state.db, &params.from, &params.to).await?;
    let speed_tests = db::get_speed_tests_in_range(&state.db, &params.from, &params.to).await?;

    let total_outages = outages.len();
    let total_downtime_s: f64 = outages.iter().filter_map(|o| o.duration_s).sum();

    // Calculate window size for uptime %
    let from_dt = chrono::DateTime::parse_from_rfc3339(&params.from)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());
    let to_dt = chrono::DateTime::parse_from_rfc3339(&params.to)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());
    let window_s = (to_dt - from_dt).num_seconds().max(1) as f64;
    let uptime_pct = (1.0 - total_downtime_s / window_s) * 100.0;

    // Build outage rows
    let mut outage_rows = String::new();
    for o in &outages {
        let ended = o.ended_at.as_deref().unwrap_or("ongoing");
        let dur = o.duration_s.map(format_duration_human).unwrap_or_else(|| "ongoing".into());
        outage_rows.push_str(&format!(
            "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            o.started_at, ended, dur, o.cause, o.targets_down
        ));
    }

    // Speed test summary
    let speed_section = if speed_tests.is_empty() {
        "<p>No speed tests recorded in this period.</p>".to_string()
    } else {
        let avg_dl: f64 = speed_tests.iter().map(|s| s.download_mbps).sum::<f64>() / speed_tests.len() as f64;
        let avg_ul: f64 = speed_tests.iter().map(|s| s.upload_mbps).sum::<f64>() / speed_tests.len() as f64;
        let avg_ping: f64 = speed_tests.iter().map(|s| s.ping_ms).sum::<f64>() / speed_tests.len() as f64;
        format!(
            "<table><tr><th>Tests</th><th>Avg Download</th><th>Avg Upload</th><th>Avg Ping</th></tr>\
             <tr><td>{}</td><td>{:.1} Mbps</td><td>{:.1} Mbps</td><td>{:.1} ms</td></tr></table>",
            speed_tests.len(), avg_dl, avg_ul, avg_ping
        )
    };

    let html = format!(
        r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Doberman Uptime Report</title>
<style>
body {{ font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }}
h1 {{ color: #1a1a1a; }} h2 {{ color: #333; margin-top: 2rem; }}
table {{ border-collapse: collapse; width: 100%; margin: 1rem 0; }}
th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; }}
th {{ background: #f5f5f5; }}
.summary {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin: 1rem 0; }}
.stat {{ background: #f9f9f9; padding: 1rem; border-radius: 8px; text-align: center; }}
.stat .value {{ font-size: 1.5rem; font-weight: bold; }}
.stat .label {{ color: #666; font-size: 0.875rem; }}
</style></head><body>
<h1>Doberman Uptime Report</h1>
<p>Period: {} to {}</p>
<div class="summary">
<div class="stat"><div class="value">{:.2}%</div><div class="label">Uptime</div></div>
<div class="stat"><div class="value">{}</div><div class="label">Outages</div></div>
<div class="stat"><div class="value">{}</div><div class="label">Total Downtime</div></div>
</div>
<h2>Outages</h2>
{outage_table}
<h2>Speed Tests</h2>
{speed_section}
<footer><p>Generated by Doberman ISP Monitor</p></footer>
</body></html>"#,
        params.from,
        params.to,
        uptime_pct,
        total_outages,
        format_duration_human(total_downtime_s),
        outage_table = if outage_rows.is_empty() {
            "<p>No outages recorded in this period.</p>".to_string()
        } else {
            format!(
                "<table><tr><th>Start</th><th>End</th><th>Duration</th><th>Cause</th><th>Targets</th></tr>{}</table>",
                outage_rows
            )
        },
        speed_section = speed_section,
    );

    let headers = [(header::CONTENT_TYPE, "text/html")];
    Ok((headers, html))
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

struct AppError(sqlx::Error);

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError(e)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        tracing::error!("API error: {}", self.0);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": self.0.to_string() })),
        )
            .into_response()
    }
}
