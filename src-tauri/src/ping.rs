use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use sqlx::SqlitePool;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

use crate::db::{self, Config, PingRecord};
use crate::outage::OutageDetector;
use crate::sse::{SseBroadcaster, SseEvent};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PingTarget {
    pub address: String,
    pub is_gateway: bool,
}

#[derive(Debug, Clone)]
pub struct PingResult {
    pub target: String,
    pub success: bool,
    pub latency_ms: Option<f64>,
    pub dns_ms: Option<f64>,
    pub error: Option<String>,
    pub is_tcp_fallback: bool,
    pub is_gateway: bool,
}

// ---------------------------------------------------------------------------
// Single-target ping
// ---------------------------------------------------------------------------

async fn ping_once(target: &PingTarget, use_tcp_fallback: bool) -> PingResult {
    let addr = &target.address;
    let mut dns_ms: Option<f64> = None;

    // Resolve the target to an IP address
    let ip: Result<IpAddr, String> = if let Ok(ip) = addr.parse::<IpAddr>() {
        Ok(ip)
    } else {
        // It's a hostname — measure DNS resolution time
        let dns_start = Instant::now();
        match tokio::net::lookup_host(format!("{addr}:0")).await {
            Ok(mut addrs) => {
                dns_ms = Some(dns_start.elapsed().as_secs_f64() * 1000.0);
                if let Some(sock_addr) = addrs.next() {
                    Ok(sock_addr.ip())
                } else {
                    Err("DNS resolved but no addresses returned".to_string())
                }
            }
            Err(e) => {
                dns_ms = Some(dns_start.elapsed().as_secs_f64() * 1000.0);
                Err(format!("DNS resolution failed: {e}"))
            }
        }
    };

    let ip = match ip {
        Ok(ip) => ip,
        Err(e) => {
            return PingResult {
                target: addr.clone(),
                success: false,
                latency_ms: None,
                dns_ms,
                error: Some(e),
                is_tcp_fallback: false,
                is_gateway: target.is_gateway,
            };
        }
    };

    if use_tcp_fallback {
        return tcp_ping(target, ip, dns_ms).await;
    }

    // Try ICMP via surge_ping
    match icmp_ping(ip).await {
        Ok(latency) => PingResult {
            target: addr.clone(),
            success: true,
            latency_ms: Some(latency),
            dns_ms,
            error: None,
            is_tcp_fallback: false,
            is_gateway: target.is_gateway,
        },
        Err(e) => PingResult {
            target: addr.clone(),
            success: false,
            latency_ms: None,
            dns_ms,
            error: Some(e),
            is_tcp_fallback: false,
            is_gateway: target.is_gateway,
        },
    }
}

async fn icmp_ping(ip: IpAddr) -> Result<f64, String> {
    let client = surge_ping::Client::new(&surge_ping::Config::default())
        .map_err(|e| format!("surge_ping client error: {e}"))?;

    let mut pinger = client.pinger(ip, surge_ping::PingIdentifier(rand_id())).await;
    pinger.timeout(Duration::from_secs(5));

    match pinger.ping(surge_ping::PingSequence(0), &[0u8; 56]).await {
        Ok((_, dur)) => Ok(dur.as_secs_f64() * 1000.0),
        Err(e) => Err(format!("{e}")),
    }
}

async fn tcp_ping(target: &PingTarget, ip: IpAddr, dns_ms: Option<f64>) -> PingResult {
    let addr = std::net::SocketAddr::new(ip, 443);
    let start = Instant::now();
    match tokio::time::timeout(Duration::from_secs(5), tokio::net::TcpStream::connect(addr)).await
    {
        Ok(Ok(_stream)) => PingResult {
            target: target.address.clone(),
            success: true,
            latency_ms: Some(start.elapsed().as_secs_f64() * 1000.0),
            dns_ms,
            error: None,
            is_tcp_fallback: true,
            is_gateway: target.is_gateway,
        },
        Ok(Err(e)) => PingResult {
            target: target.address.clone(),
            success: false,
            latency_ms: None,
            dns_ms,
            error: Some(format!("TCP connect failed: {e}")),
            is_tcp_fallback: true,
            is_gateway: target.is_gateway,
        },
        Err(_) => PingResult {
            target: target.address.clone(),
            success: false,
            latency_ms: None,
            dns_ms,
            error: Some("TCP connect timed out (5s)".to_string()),
            is_tcp_fallback: true,
            is_gateway: target.is_gateway,
        },
    }
}

fn rand_id() -> u16 {
    (std::process::id() as u16).wrapping_add(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos() as u16,
    )
}

// ---------------------------------------------------------------------------
// Ping all targets concurrently
// ---------------------------------------------------------------------------

pub async fn ping_all(
    targets: &[String],
    gateway_ip: Option<&str>,
    use_tcp_fallback: bool,
) -> Vec<PingResult> {
    let mut join_set = tokio::task::JoinSet::new();

    for t in targets {
        let is_gateway = gateway_ip.map_or(false, |gw| gw == t);
        let target = PingTarget {
            address: t.clone(),
            is_gateway,
        };
        let use_tcp = use_tcp_fallback;
        join_set.spawn(async move { ping_once(&target, use_tcp).await });
    }

    // Also ping the gateway if it's not already in the target list
    if let Some(gw) = gateway_ip {
        if !targets.iter().any(|t| t == gw) {
            let target = PingTarget {
                address: gw.to_string(),
                is_gateway: true,
            };
            let use_tcp = use_tcp_fallback;
            join_set.spawn(async move { ping_once(&target, use_tcp).await });
        }
    }

    let mut results = Vec::new();
    while let Some(res) = join_set.join_next().await {
        match res {
            Ok(ping_result) => results.push(ping_result),
            Err(e) => error!("Ping task panicked: {e}"),
        }
    }
    results
}

// ---------------------------------------------------------------------------
// Continuous ping loop
// ---------------------------------------------------------------------------

pub async fn start_ping_loop(
    pool: Arc<SqlitePool>,
    broadcaster: SseBroadcaster,
    config: Arc<RwLock<Config>>,
) {
    // Detect ICMP permission on startup
    let use_tcp_fallback = match detect_icmp_support().await {
        true => {
            info!("ICMP ping available");
            false
        }
        false => {
            warn!("ICMP ping unavailable (permission denied), falling back to TCP probes on port 443");
            true
        }
    };

    // Initialize outage detector with threshold from config
    let initial_threshold = {
        let cfg = config.read().await;
        cfg.outage_threshold
    };
    let mut outage_detector = OutageDetector::new(initial_threshold);

    loop {
        let (targets, gateway_ip, interval_s, outage_threshold) = {
            let cfg = config.read().await;
            let targets: Vec<String> =
                serde_json::from_str(&cfg.targets).unwrap_or_else(|_| {
                    vec![
                        "8.8.8.8".to_string(),
                        "1.1.1.1".to_string(),
                        "208.67.222.222".to_string(),
                    ]
                });
            (targets, cfg.gateway_ip.clone(), cfg.ping_interval_s as u64, cfg.outage_threshold)
        };

        // Keep threshold in sync with config
        outage_detector.set_threshold(outage_threshold);

        let results = ping_all(
            &targets,
            gateway_ip.as_deref(),
            use_tcp_fallback,
        )
        .await;

        let now = Utc::now().to_rfc3339();

        for result in &results {
            // Insert into DB
            let record = PingRecord {
                id: None,
                timestamp: now.clone(),
                target: result.target.clone(),
                success: result.success,
                latency_ms: result.latency_ms,
                dns_ms: result.dns_ms,
                error: result.error.clone(),
            };

            if let Err(e) = db::insert_ping(&pool, &record).await {
                error!("Failed to insert ping for {}: {e}", result.target);
            }

            // Broadcast via SSE
            broadcaster.send(SseEvent::PingResult {
                target: result.target.clone(),
                success: result.success,
                latency_ms: result.latency_ms,
                dns_ms: result.dns_ms,
                timestamp: now.clone(),
            });
        }

        // Feed results to outage detector
        outage_detector
            .process_ping_round(&results, &pool, &broadcaster)
            .await;

        tokio::time::sleep(Duration::from_secs(interval_s)).await;
    }
}

/// Test whether we have permission to send ICMP packets.
async fn detect_icmp_support() -> bool {
    match surge_ping::Client::new(&surge_ping::Config::default()) {
        Ok(client) => {
            // Try pinging localhost as a quick permission check
            let ip: IpAddr = "127.0.0.1".parse().unwrap();
            let mut pinger = client.pinger(ip, surge_ping::PingIdentifier(0)).await;
            pinger.timeout(Duration::from_secs(2));
            match pinger.ping(surge_ping::PingSequence(0), &[0u8; 8]).await {
                Ok(_) => true,
                Err(e) => {
                    let err_str = format!("{e}");
                    // Permission errors on macOS/Linux
                    if err_str.contains("ermission")
                        || err_str.contains("EACCES")
                        || err_str.contains("EPERM")
                        || err_str.contains("operation not permitted")
                    {
                        false
                    } else {
                        // Some other error (e.g., timeout) — ICMP might still work
                        true
                    }
                }
            }
        }
        Err(e) => {
            let err_str = format!("{e}");
            if err_str.contains("ermission")
                || err_str.contains("EACCES")
                || err_str.contains("EPERM")
                || err_str.contains("operation not permitted")
            {
                false
            } else {
                warn!("surge_ping client creation failed with unexpected error: {e}");
                false
            }
        }
    }
}
