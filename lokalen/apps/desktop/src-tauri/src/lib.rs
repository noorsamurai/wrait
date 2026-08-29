pub mod portable;
pub mod relay;
#[cfg(windows)]
pub mod service;

use tauri::Window;

// Only the macOS setup hook reaches for a window by name.
#[cfg(target_os = "macos")]
use tauri::Manager;

/// Pulls the window to the user's attention without stealing focus outright.
///
/// The chat itself plays a tone from the webview, which is identical across
/// platforms; this is the part only the native shell can do - bouncing the
/// dock icon on macOS and flashing the taskbar button on Windows. Both stop
/// on their own as soon as the user looks at the window.
#[tauri::command]
fn alert_window(window: Window) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::UserAttentionType;

        if window.is_minimized().unwrap_or(false) {
            window.unminimize().map_err(|e| e.to_string())?;
        }
        window
            .request_user_attention(Some(UserAttentionType::Informational))
            .map_err(|e| e.to_string())?;
    }

    #[cfg(not(desktop))]
    {
        // On iOS the notification plugin owns this; nothing to do here.
        let _ = window;
    }

    Ok(())
}

/// Brings the window forward when the user acts on a notification.
#[tauri::command]
fn focus_window(window: Window) -> Result<(), String> {
    #[cfg(desktop)]
    {
        if window.is_minimized().unwrap_or(false) {
            window.unminimize().map_err(|e| e.to_string())?;
        }
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }

    #[cfg(not(desktop))]
    let _ = window;

    Ok(())
}

/// This machine's part in the office: hosting it, or standing by to.
#[derive(Default)]
pub struct Office(tokio::sync::Mutex<Option<std::sync::Arc<relay::cluster::Node>>>);

/// Opens this machine's copy of the office, once.
///
/// The supervisor started here is what keeps the office alive when a computer
/// is switched off: it follows whoever is hosting and, if nobody is, offers to
/// take over.
async fn office_node(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, Office>,
    port: Option<u16>,
    mode: Option<String>,
    name: Option<String>,
) -> std::sync::Arc<relay::cluster::Node> {
    let mut held = state.0.lock().await;
    if let Some(node) = held.as_ref() {
        return node.clone();
    }

    let node = relay::cluster::Node::open(
        &portable::relay_dir(),
        port.unwrap_or(8787),
        // Open by default: typing a name is the whole point of an office
        // somebody starts from a portable exe.
        &name.unwrap_or_else(|| "Lokalen".to_string()),
        relay::model::OfficeMode::parse(mode.as_deref().unwrap_or("open")),
    );

    let handle = app.clone();
    relay::cluster::supervise(node.clone(), move |status| {
        use tauri::Emitter;
        // The window is holding a socket to a machine that may have just been
        // switched off, so it has to be told where the office went.
        let _ = handle.emit("office-moved", status);
    });

    *held = Some(node.clone());
    node
}

/// Starts hosting an office on this computer.
///
/// This is what makes a single portable exe self-sufficient: one person clicks
/// Host, and everyone else points their app at the address returned here. No
/// Node, no database to install, nothing unpacked at launch.
#[tauri::command]
async fn start_relay(
    app: tauri::AppHandle,
    state: tauri::State<'_, Office>,
    port: Option<u16>,
    mode: Option<String>,
    name: Option<String>,
) -> Result<relay::RelayInfo, String> {
    let node = office_node(&app, &state, port, mode, name).await;
    node.host().await
}

/// Follows an office another computer is hosting.
///
/// The token is the person's own session there: replication hands this machine
/// the whole office, so it has to be someone who is already in it.
#[tauri::command]
async fn join_office(
    app: tauri::AppHandle,
    state: tauri::State<'_, Office>,
    url: String,
    token: String,
) -> Result<relay::cluster::Status, String> {
    let node = office_node(&app, &state, None, None, None).await;
    node.join(&url, &token).await?;
    Ok(node.status())
}

/// Where the office is being served right now, and this machine's part in it.
#[tauri::command]
async fn cluster_status(
    state: tauri::State<'_, Office>,
) -> Result<Option<relay::cluster::Status>, String> {
    Ok(state.0.lock().await.as_ref().map(|node| node.status()))
}

#[tauri::command]
async fn stop_relay(state: tauri::State<'_, Office>) -> Result<(), String> {
    if let Some(node) = state.0.lock().await.as_ref() {
        node.stand_down().await;
    }
    Ok(())
}

#[tauri::command]
async fn relay_status(
    state: tauri::State<'_, Office>,
) -> Result<Option<relay::RelayInfo>, String> {
    Ok(state.0.lock().await.as_ref().and_then(|node| node.relay_info()))
}

/// Streams an attachment straight from the relay onto disk.
///
/// Two reasons this is not done in the webview. The file never exists in
/// memory as a whole, so a two-gigabyte transfer costs the same as a small
/// one; and writing from Rust is not bound by the webview's filesystem
/// scope, so people can save wherever they actually want the file rather
/// than only into Downloads, Documents or Desktop.
#[tauri::command]
async fn save_attachment(url: String, path: String) -> Result<u64, String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let response = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Servern svarade {}.", response.status().as_u16()));
    }

    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| format!("Kunde inte skriva till {path}: {e}"))?;

    let mut written: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        written += chunk.len() as u64;
    }
    file.flush().await.map_err(|e| e.to_string())?;

    Ok(written)
}

/// Looks for offices being hosted on this network.
///
/// Saves everyone the ritual of reading an IP address out loud: the hosting
/// machine answers a UDP probe and the app fills the address in.
#[tauri::command]
async fn discover_offices(timeout_ms: Option<u64>) -> Result<Vec<relay::discovery::DiscoveredOffice>, String> {
    let window = std::time::Duration::from_millis(timeout_ms.unwrap_or(1200).clamp(200, 5000));
    Ok(relay::discovery::discover(window).await)
}

/// Writes the whole office - accounts, messages and attachments - to one file.
///
/// One file rather than a folder because a backup nobody can carry on a stick
/// is a backup nobody takes.
#[tauri::command]
async fn export_office(
    app: tauri::AppHandle,
    state: tauri::State<'_, Office>,
    path: String,
) -> Result<relay::backup::Summary, String> {
    let node = office_node(&app, &state, None, None, None).await;
    node.export(std::path::Path::new(&path))
}

/// Replaces this machine's office with one from a backup file.
#[tauri::command]
async fn import_office(
    app: tauri::AppHandle,
    state: tauri::State<'_, Office>,
    path: String,
) -> Result<relay::backup::Summary, String> {
    let node = office_node(&app, &state, None, None, None).await;
    node.restore(std::path::Path::new(&path)).await
}

/* ------------------------------------------------------------------ */
/* Living in the tray                                                  */
/* ------------------------------------------------------------------ */

/// Puts the unread count on the tray icon's tooltip.
///
/// The window spends most of its life hidden behind a journal system, so the
/// tray is where anyone actually looks to see whether something is waiting.
#[tauri::command]
fn set_badge(app: tauri::AppHandle, unread: u32) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let tooltip = match unread {
            0 => "Lokalen".to_string(),
            1 => "Lokalen - 1 oläst".to_string(),
            n => format!("Lokalen - {n} olästa"),
        };
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            tray.set_tooltip(Some(&tooltip)).map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(desktop))]
    let _ = (app, unread);
    Ok(())
}

/// Starts the app when the person logs in.
///
/// Off by default and asked for explicitly: a clinic wants this on every
/// machine, but deciding that for someone is not this app's business.
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = app.autolaunch();
        if enabled {
            manager.enable().map_err(|e| e.to_string())?;
        } else {
            manager.disable().map_err(|e| e.to_string())?;
        }
        return manager.is_enabled().map_err(|e| e.to_string());
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
        Ok(false)
    }
}

#[tauri::command]
fn autostart_enabled(app: tauri::AppHandle) -> bool {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        return app.autolaunch().is_enabled().unwrap_or(false);
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        false
    }
}

#[cfg(desktop)]
const TRAY_ID: &str = "lokalen";

/// Builds the tray icon and its menu.
///
/// Closing the window hides it rather than quitting, because a messenger that
/// is not running is a messenger nobody can reach - and the close button is
/// how most people "put something away".
#[cfg(desktop)]
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItemBuilder::with_id("show", "Visa Lokalen").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Avsluta").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show]).separator().items(&[&quit]).build()?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Lokalen")
        .menu(&menu)
        // The menu belongs on right-click; a left click should just bring the
        // window back, which is what everyone tries first.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => reveal(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

/// Brings the window back from the tray.
#[cfg(desktop)]
fn reveal(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Where this run keeps its data, and whether that is beside the exe.
#[tauri::command]
fn storage_location() -> serde_json::Value {
    serde_json::json!({
        "path": portable::data_dir().to_string_lossy(),
        "portable": portable::is_portable(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default().manage(Office::default());

    #[cfg(desktop)]
    {
        // Registered with no arguments: the app decides for itself whether to
        // open a window on a login start, and starting minimised into the
        // tray is the whole point.
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
    }

    builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            alert_window,
            focus_window,
            start_relay,
            join_office,
            cluster_status,
            stop_relay,
            relay_status,
            discover_offices,
            save_attachment,
            storage_location,
            set_badge,
            set_autostart,
            autostart_enabled,
            export_office,
            import_office
        ])
        .setup(|app| {
            #[cfg(desktop)]
            // Best effort: a desktop with no system tray - some Linux
            // sessions - should still get a working window.
            if let Err(err) = build_tray(app.handle()) {
                eprintln!("[tray] ingen ikon i aktivitetsfältet: {err}");
            }

            // Vibrancy is only meaningful on desktop; on iOS the webview
            // already composites against the system background.
            #[cfg(target_os = "macos")]
            {
                use tauri::window::{Effect, EffectsBuilder};
                if let Some(window) = app.get_webview_window("main") {
                    // Best effort: an older macOS without this material should
                    // still get a usable window rather than a failed launch.
                    let _ = window.set_effects(
                        EffectsBuilder::new()
                            .effect(Effect::HudWindow)
                            .build(),
                    );
                }
            }

            #[cfg(not(target_os = "macos"))]
            let _ = app;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing puts the app in the tray instead of quitting. A
            // messenger that is not running is a messenger nobody can reach,
            // and the close button is how most people put something away.
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                use tauri::Manager;
                if window.app_handle().tray_by_id(TRAY_ID).is_some() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            #[cfg(not(desktop))]
            let _ = (window, event);
        })
        .run(tauri::generate_context!())
        .expect("fel vid körning av Lokalen");
}
