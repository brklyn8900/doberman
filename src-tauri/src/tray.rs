use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

fn app_icon(app: &AppHandle) -> Option<tauri::image::Image<'static>> {
    app.default_window_icon().cloned().map(|icon| icon.to_owned())
}

/// Build the tray menu with the given status text.
fn build_tray_menu(app: &AppHandle, status_text: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let show_dashboard =
        MenuItem::with_id(app, "show_dashboard", "Show Dashboard", true, None::<&str>)?;
    let status_item = MenuItem::with_id(app, "status", status_text, false, None::<&str>)?;
    let speed_test = MenuItem::with_id(app, "speed_test", "Run Speed Test", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &show_dashboard,
            &PredefinedMenuItem::separator(app)?,
            &status_item,
            &PredefinedMenuItem::separator(app)?,
            &speed_test,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

/// Set up the system tray with menu and event handlers.
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app, "Status: Connected")?;

    let mut builder = TrayIconBuilder::with_id("main");
    if let Some(icon) = app_icon(app) {
        builder = builder.icon(icon);
    }

    builder
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Doberman - Connected")
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show_dashboard" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

/// Update the tray icon and status menu text based on connection state.
pub fn update_tray_status(app: &AppHandle, is_connected: bool) {
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };

    let (tooltip, status_text) = if is_connected {
        ("Doberman - Connected", "Status: Connected")
    } else {
        ("Doberman - Outage Detected", "Status: Outage Detected")
    };

    if let Some(icon) = app_icon(app) {
        let _ = tray.set_icon(Some(icon));
    }
    let _ = tray.set_tooltip(Some(tooltip));

    if let Ok(menu) = build_tray_menu(app, status_text) {
        let _ = tray.set_menu(Some(menu));
    }
}
