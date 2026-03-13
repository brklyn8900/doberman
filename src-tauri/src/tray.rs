use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

const ICON_SIZE: u32 = 16;

/// Generate a 16x16 RGBA icon with a colored circle on transparent background.
fn generate_circle_icon(r: u8, g: u8, b: u8) -> Vec<u8> {
    let size = ICON_SIZE as i32;
    let center = size / 2;
    let radius = center - 1;
    let radius_sq = radius * radius;
    let mut pixels = vec![0u8; (ICON_SIZE * ICON_SIZE * 4) as usize];

    for y in 0..size {
        for x in 0..size {
            let dx = x - center;
            let dy = y - center;
            let dist_sq = dx * dx + dy * dy;
            let offset = ((y * size + x) * 4) as usize;

            if dist_sq <= radius_sq {
                pixels[offset] = r;
                pixels[offset + 1] = g;
                pixels[offset + 2] = b;
                pixels[offset + 3] = 255;
            }
        }
    }
    pixels
}

fn green_icon() -> Image<'static> {
    let pixels = generate_circle_icon(34, 197, 94); // green-500
    Image::new_owned(pixels, ICON_SIZE, ICON_SIZE)
}

fn red_icon() -> Image<'static> {
    let pixels = generate_circle_icon(239, 68, 68); // red-500
    Image::new_owned(pixels, ICON_SIZE, ICON_SIZE)
}

/// Build the tray menu with the given status text.
fn build_tray_menu(app: &AppHandle, status_text: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let show_dashboard = MenuItem::with_id(app, "show_dashboard", "Show Dashboard", true, None::<&str>)?;
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

    TrayIconBuilder::with_id("main")
        .icon(green_icon())
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

    let (icon, tooltip, status_text) = if is_connected {
        (green_icon(), "Doberman - Connected", "Status: Connected")
    } else {
        (
            red_icon(),
            "Doberman - Outage Detected",
            "Status: Outage Detected",
        )
    };

    let _ = tray.set_icon(Some(icon));
    let _ = tray.set_tooltip(Some(tooltip));

    if let Ok(menu) = build_tray_menu(app, status_text) {
        let _ = tray.set_menu(Some(menu));
    }
}
