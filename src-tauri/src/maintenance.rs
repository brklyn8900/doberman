use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::RwLock;
use tracing::{error, info};

use crate::db::Config;

/// Delete pings older than `retention_days`.
pub async fn delete_old_pings(pool: &SqlitePool, retention_days: i64) -> Result<u64, sqlx::Error> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(retention_days)).to_rfc3339();
    let result = sqlx::query("DELETE FROM pings WHERE timestamp < ?")
        .bind(&cutoff)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

/// Delete rolling stats older than 180 days.
pub async fn delete_old_stats(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(180)).to_rfc3339();
    let result = sqlx::query("DELETE FROM rolling_stats WHERE timestamp < ?")
        .bind(&cutoff)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

/// Run VACUUM to reclaim disk space after deletions.
pub async fn vacuum_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(pool)
        .await?;
    // Note: VACUUM requires no active transactions; best-effort here.
    match sqlx::query("VACUUM").execute(pool).await {
        Ok(_) => info!("Database VACUUM completed"),
        Err(e) => info!("Database VACUUM skipped (may be in-use): {e}"),
    }
    Ok(())
}

/// Runs maintenance tasks at startup and every 24 hours.
pub async fn start_maintenance_loop(pool: Arc<SqlitePool>, config: Arc<RwLock<Config>>) {
    loop {
        let retention_days = {
            let cfg = config.read().await;
            cfg.data_retention_days
        };

        info!("Running maintenance (retention={retention_days} days)");

        match delete_old_pings(&pool, retention_days).await {
            Ok(n) if n > 0 => info!("Pruned {n} old ping records"),
            Ok(_) => {}
            Err(e) => error!("Failed to prune old pings: {e}"),
        }

        match delete_old_stats(&pool).await {
            Ok(n) if n > 0 => info!("Pruned {n} old rolling_stats records"),
            Ok(_) => {}
            Err(e) => error!("Failed to prune old stats: {e}"),
        }

        if let Err(e) = vacuum_db(&pool).await {
            error!("Vacuum failed: {e}");
        }

        // Sleep 24 hours
        tokio::time::sleep(std::time::Duration::from_secs(86_400)).await;
    }
}
