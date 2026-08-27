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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![alert_window, focus_window])
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
