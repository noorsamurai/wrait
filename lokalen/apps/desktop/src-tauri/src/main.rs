// Hide the console window that Windows would otherwise open behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Must happen before Tauri builds the webview, or WebView2 will already
    // have picked a profile folder under AppData and the app would stop being
    // portable.
    lokalen_lib::portable::redirect_webview_profile();
    lokalen_lib::run()
}
