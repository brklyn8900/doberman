pub mod api;
pub mod db;
pub mod maintenance;
pub mod outage;
pub mod ping;
pub mod speed_test;
pub mod sse;
pub mod stats;
pub mod traceroute;
pub mod tray;

use std::sync::Arc;

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{Manager, WindowEvent};
use tokio::sync::RwLock;

#[derive(Clone, Serialize)]
struct ApiPort(u16);

/// Managed state so other modules can access the database pool.
pub struct DbPool(pub Arc<SqlitePool>);

#[tauri::command]
fn get_api_port(state: tauri::State<ApiPort>) -> u16 {
    state.0
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .init();

    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();

            // Initialize the database
            let app_data_dir = handle
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");

            let pool = tauri::async_runtime::block_on(async {
                db::init_db(&app_data_dir).await
            })
            .expect("failed to initialize database");

            let pool = Arc::new(pool);
            handle.manage(DbPool(pool.clone()));
            tracing::info!("Database initialized");

            // Create SSE broadcaster
            let broadcaster = sse::SseBroadcaster::new();

            // Load initial config and wrap in RwLock for shared access
            let initial_config = tauri::async_runtime::block_on(async {
                db::get_config(&pool).await
            })
            .expect("failed to load initial config");
            let config = Arc::new(RwLock::new(initial_config));
            let speed_test_manager = Arc::new(speed_test::SpeedTestManager::new());

            // Spawn the ping loop
            {
                let pool = pool.clone();
                let broadcaster = broadcaster.clone();
                let config = config.clone();
                tauri::async_runtime::spawn(async move {
                    ping::start_ping_loop(pool, broadcaster, config).await;
                });
            }

            // Spawn the rolling stats loop
            {
                let pool = pool.clone();
                let broadcaster = broadcaster.clone();
                tauri::async_runtime::spawn(async move {
                    stats::start_stats_loop(pool, broadcaster).await;
                });
            }

            // Spawn the scheduled speed test loop
            {
                let pool = pool.clone();
                let broadcaster = broadcaster.clone();
                let config = config.clone();
                let speed_test_manager = speed_test_manager.clone();
                tauri::async_runtime::spawn(async move {
                    speed_test::start_scheduled_speed_test_loop(
                        pool,
                        broadcaster,
                        config,
                        speed_test_manager,
                    )
                    .await;
                });
            }

            // Spawn the maintenance / data-retention loop
            {
                let pool = pool.clone();
                let config = config.clone();
                tauri::async_runtime::spawn(async move {
                    maintenance::start_maintenance_loop(pool, config).await;
                });
            }

            // Bind axum on a random available port
            let listener = std::net::TcpListener::bind("127.0.0.1:0")
                .expect("failed to bind API server");
            listener
                .set_nonblocking(true)
                .expect("failed to set API listener nonblocking");
            let port = listener.local_addr().unwrap().port();
            tracing::info!("API server will listen on http://127.0.0.1:{}", port);

            // Store port in Tauri managed state so frontend can retrieve it
            handle.manage(ApiPort(port));

            // Spawn axum server on Tauri's tokio runtime
            let app_state = api::AppState {
                db: pool,
                broadcaster,
                config,
                speed_test_manager,
            };
            tauri::async_runtime::spawn(async move {
                let router = api::create_router(app_state);

                let listener = tokio::net::TcpListener::from_std(listener)
                    .expect("failed to convert listener");

                tracing::info!("API server listening on port {}", port);
                axum::serve(listener, router)
                    .await
                    .expect("API server error");
            });

            // Set up system tray
            tray::setup_tray(&handle)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![get_api_port])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
