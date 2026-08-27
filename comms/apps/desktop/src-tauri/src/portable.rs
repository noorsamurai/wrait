//! Portable storage.
//!
//! A portable build keeps everything it creates in one folder beside the
//! executable, so deleting that folder removes every trace of the app - no
//! stray AppData, no registry, nothing to uninstall.
//!
//! If that folder cannot be created (the exe was dropped in Program Files, or
//! sits on read-only media) this falls back to the platform's normal data
//! directory rather than failing to launch.

use std::path::PathBuf;

const FOLDER: &str = "WraitComms-Data";

/// True when the app is running portably, i.e. writing beside its exe.
pub fn is_portable() -> bool {
    beside_exe().is_some()
}

fn beside_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.join(FOLDER);
    // Probing by actually creating it: a read-only or privileged location
    // fails here rather than at the first write, much later.
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn fallback() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_DATA_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("WraitComms");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Where the app keeps its data this run.
pub fn data_dir() -> PathBuf {
    beside_exe().unwrap_or_else(fallback)
}

/// Where the embedded relay stores its database and file blobs.
pub fn relay_dir() -> PathBuf {
    let dir = data_dir().join("relay");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Points the webview's own profile - which is where `localStorage` lives -
/// into the portable folder.
///
/// Must run before the webview is created, otherwise WebView2 has already
/// chosen a folder under AppData and the sign-in would not travel with the
/// exe. Windows-only: WKWebView offers no equivalent knob.
pub fn redirect_webview_profile() {
    if cfg!(target_os = "windows") && std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", data_dir().join("webview"));
    }
}
