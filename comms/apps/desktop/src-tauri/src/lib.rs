pub mod portable;
pub mod relay;

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

/// Live handle on the relay this machine is hosting, if any.
#[derive(Default)]
pub struct HostedRelay(tokio::sync::Mutex<Option<relay::Relay>>);

/// Starts hosting an office on this computer.
///
/// This is what makes a single portable exe self-sufficient: one person clicks
/// Host, and everyone else points their app at the address returned here. No
/// Node, no database to install, nothing unpacked at launch.
#[tauri::command]
async fn start_relay(
    state: tauri::State<'_, HostedRelay>,
    port: Option<u16>,
) -> Result<relay::RelayInfo, String> {
    let mut hosted = state.0.lock().await;
    if let Some(existing) = hosted.as_ref() {
        // Already hosting: report the running relay rather than binding twice.
        return Ok(existing.info.clone());
    }

    let started = relay::start(port.unwrap_or(8787), &portable::relay_dir()).await?;
    let info = started.info.clone();
    *hosted = Some(started);
    Ok(info)
}

#[tauri::command]
async fn stop_relay(state: tauri::State<'_, HostedRelay>) -> Result<(), String> {
    let mut hosted = state.0.lock().await;
    if let Some(relay) = hosted.take() {
        relay.stop().await;
    }
    Ok(())
}

#[tauri::command]
async fn relay_status(
    state: tauri::State<'_, HostedRelay>,
) -> Result<Option<relay::RelayInfo>, String> {
    Ok(state.0.lock().await.as_ref().map(|r| r.info.clone()))
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
    tauri::Builder::default()
        .manage(HostedRelay::default())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            alert_window,
            focus_window,
            start_relay,
            stop_relay,
            relay_status,
            storage_location
        ])
        .setup(|app| {
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
        .run(tauri::generate_context!())
        .expect("error while running Wrait Comms");
}
