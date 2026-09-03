//! Safe Rust wrapper around native/cef_bridge (strata_cef_bridge.dll).
//!
//! Threading contract (see native/cef_bridge/include/strata_bridge.h): every
//! function here except `execute_process_if_subprocess` must run on the same
//! OS thread — the one that calls `initialize()`, which in this app is
//! Tauri's own main/event-loop thread. `run_cef` is how every call site
//! gets there safely regardless of which thread it's invoked from.

use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::sync::{mpsc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Runtime, Wry};

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
struct TabStateRaw {
    can_go_back: c_int,
    can_go_forward: c_int,
    is_loading: c_int,
    scroll_x: f64,
    scroll_y: f64,
}

extern "C" {
    fn strata_cef_execute_process() -> c_int;
    fn strata_cef_initialize() -> c_int;
    fn strata_cef_do_message_loop_work();
    fn strata_cef_set_shortcut_callback(callback: extern "C" fn(u64, *const c_char));
    fn strata_cef_set_download_callback(
        callback: extern "C" fn(
            u64,
            u64,
            *const c_char,
            *const c_char,
            *const c_char,
            *const c_char,
            i64,
            i64,
        ),
    );
    fn strata_cef_set_popup_callback(callback: extern "C" fn(u64, *const c_char));
    fn strata_cef_set_permission_callback(
        callback: extern "C" fn(u64, u64, *const c_char, *const c_char),
    );
    fn strata_cef_respond_permission(request_id: u64, allow: c_int);
    fn strata_cef_create_browser(
        parent_hwnd: *mut c_void,
        x: c_int,
        y: c_int,
        width: c_int,
        height: c_int,
        url: *const c_char,
        is_private: c_int,
        cache_path: *const c_char,
    ) -> u64;
    fn strata_cef_resize_browser(browser_id: u64, x: c_int, y: c_int, width: c_int, height: c_int);
    fn strata_cef_set_visible(browser_id: u64, visible: c_int);
    fn strata_cef_navigate(browser_id: u64, url: *const c_char);
    fn strata_cef_go_back(browser_id: u64);
    fn strata_cef_go_forward(browser_id: u64);
    fn strata_cef_reload(browser_id: u64);
    fn strata_cef_close_browser(browser_id: u64);
    fn strata_cef_get_tab_state(
        browser_id: u64,
        out_state: *mut TabStateRaw,
        url_buf: *mut c_char,
        url_buf_len: c_int,
        title_buf: *mut c_char,
        title_buf_len: c_int,
        favicon_buf: *mut c_char,
        favicon_buf_len: c_int,
    ) -> c_int;
    fn strata_cef_shutdown();
}

/// Runs `f` on the thread that owns Tauri's event loop (== CEF's UI thread
/// in this app). Safe to call from any thread, including that one: Tauri's
/// dispatcher runs `f` inline immediately when already on the main thread
/// (verified against tauri-runtime-wry's `send_user_message`), so this
/// never deadlocks — it only actually hops threads when called from a
/// worker thread (e.g. inside a `#[tauri::command]`).
pub fn run_cef<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    f: impl FnOnce() -> T + Send + 'static,
) -> T {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .expect("Tauri event loop is gone");
    rx.recv()
        .expect("main thread dropped the response channel")
}

/// Call as the literal first thing in `main()`, before any other setup. If
/// this returns `Some`, the current process invocation was a CEF
/// subprocess (renderer/GPU/utility) that has now finished running — exit
/// immediately with that code and do nothing else.
pub fn execute_process_if_subprocess() -> Option<i32> {
    let code = unsafe { strata_cef_execute_process() };
    if code >= 0 {
        Some(code)
    } else {
        None
    }
}

/// Initializes CEF. Must be called directly (not via `run_cef`, since no
/// Tauri event loop exists yet) from what will become the app's main
/// thread, before `tauri::Builder::run` starts.
pub fn initialize() -> bool {
    unsafe { strata_cef_initialize() != 0 }
}

pub fn do_message_loop_work() {
    unsafe { strata_cef_do_message_loop_work() }
}

// Holds the AppHandle so the C callback below (a plain extern "C" fn, which
// can't capture any state) has something to emit events through. Set once
// in lib.rs's setup() hook, right before registering the callback.
static APP_HANDLE: OnceLock<AppHandle<Wry>> = OnceLock::new();

// Which window each browser id belongs to — populated by lib.rs's
// create_tab whenever it creates a browser, and consulted below so a
// shortcut typed into one window's page never leaks into another window's
// frontend (this matters once incognito windows exist alongside the main
// one; see open_incognito_window in lib.rs).
static BROWSER_WINDOWS: OnceLock<Mutex<HashMap<u64, String>>> = OnceLock::new();

fn browser_windows() -> &'static Mutex<HashMap<u64, String>> {
    BROWSER_WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register_browser_window(browser_id: u64, window_label: String) {
    browser_windows().lock().unwrap().insert(browser_id, window_label);
}

pub fn unregister_browser_window(browser_id: u64) {
    browser_windows().lock().unwrap().remove(&browser_id);
}

/// Registers this app's AppHandle and starts forwarding CEF chrome-level
/// keyboard shortcuts (Ctrl+T, Ctrl+H, ...) as a Tauri "shortcut" event —
/// see strata_client.h for the full list of action strings. Call once
/// during setup, on the main thread, before creating any browsers.
pub fn set_shortcut_forwarding(app: AppHandle<Wry>) {
    let _ = APP_HANDLE.set(app);
    unsafe { strata_cef_set_shortcut_callback(handle_shortcut_callback) };
}

extern "C" fn handle_shortcut_callback(browser_id: u64, action: *const c_char) {
    let Some(app) = APP_HANDLE.get() else { return };
    if action.is_null() {
        return;
    }
    // No known window for this browser id — rather than guess, drop the
    // shortcut. Shouldn't happen: create_tab registers the mapping before
    // the browser can receive any key events.
    let Some(label) = browser_windows().lock().unwrap().get(&browser_id).cloned() else {
        return;
    };
    // Safety: strata_client.cpp always passes a nul-terminated string
    // literal (one of the fixed action names in OnPreKeyEvent), valid for
    // the duration of this call.
    let action = unsafe { CStr::from_ptr(action) }.to_string_lossy();
    let _ = app.emit_to(label, "shortcut", action.into_owned());
}

/// Raw shape of a download-progress report from CEF — see
/// strata_client.cpp's OnBeforeDownload/OnDownloadUpdated. This module only
/// translates the C callback into this struct and broadcasts it as a
/// "download-event" Tauri event; lib.rs is where the actual decisions live
/// (persisting to storage, skipping incognito downloads, telling the
/// Downloads tab to refresh) — cef_bridge stays a pure FFI translator, the
/// same division as every other callback in this file.
/// Which window a browser id belongs to, if any is known — used by lib.rs's
/// download-event handling to skip persisting downloads started from an
/// incognito window (see register_browser_window above).
pub fn window_label_for_browser(browser_id: u64) -> Option<String> {
    browser_windows().lock().unwrap().get(&browser_id).cloned()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadEvent {
    pub download_id: u64,
    pub browser_id: u64,
    pub state: String,
    pub url: String,
    pub file_path: String,
    pub file_name: String,
    pub received_bytes: i64,
    pub total_bytes: i64,
}

/// Starts forwarding CEF download activity as a "download-event" Tauri
/// event. Call once during setup, same thread rules as
/// set_shortcut_forwarding (and safe to call alongside it — both share the
/// same APP_HANDLE).
pub fn set_download_forwarding(app: AppHandle<Wry>) {
    let _ = APP_HANDLE.set(app);
    unsafe { strata_cef_set_download_callback(handle_download_callback) };
}

extern "C" fn handle_download_callback(
    download_id: u64,
    browser_id: u64,
    state: *const c_char,
    url: *const c_char,
    file_path: *const c_char,
    file_name: *const c_char,
    received_bytes: i64,
    total_bytes: i64,
) {
    let Some(app) = APP_HANDLE.get() else { return };
    let event = DownloadEvent {
        download_id,
        browser_id,
        state: cstr_ptr_to_string(state),
        url: cstr_ptr_to_string(url),
        file_path: cstr_ptr_to_string(file_path),
        file_name: cstr_ptr_to_string(file_name),
        received_bytes,
        total_bytes,
    };
    let _ = app.emit("download-event", event);
}

/// Starts forwarding "open a link in a new tab/window" requests (CEF's
/// OnBeforePopup — target="_blank" links, window.open(), the context menu's
/// "open in new tab/window") as a window-scoped "open-tab" event. Without
/// this, the frontend never even hears about the request and OnBeforePopup
/// unconditionally cancelling it (see strata_client.cpp) means the link
/// would otherwise silently go nowhere.
pub fn set_popup_forwarding(app: AppHandle<Wry>) {
    let _ = APP_HANDLE.set(app);
    unsafe { strata_cef_set_popup_callback(handle_popup_callback) };
}

extern "C" fn handle_popup_callback(browser_id: u64, url: *const c_char) {
    let url = cstr_ptr_to_string(url);
    let Some(app) = APP_HANDLE.get() else {
        eprintln!("[Strata] handle_popup_callback: no APP_HANDLE yet, dropping {url}");
        return;
    };
    let Some(label) = browser_windows().lock().unwrap().get(&browser_id).cloned() else {
        eprintln!(
            "[Strata] handle_popup_callback: no window known for browser_id={browser_id}, dropping {url}"
        );
        return;
    };
    if url.is_empty() {
        return;
    }
    eprintln!("[Strata] handle_popup_callback: emitting open-tab to {label}: {url}");
    let _ = app.emit_to(label, "open-tab", url);
}

/// A pending permission request forwarded from CEF — see
/// strata_client.cpp's OnRequestMediaAccessPermission/OnShowPermissionPrompt.
/// `id` is what a later respond_permission call must echo back.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionEvent {
    pub id: u64,
    pub origin: String,
    pub kind: String,
}

/// Starts forwarding CEF permission requests (camera, microphone,
/// location, notifications, ...) as a window-scoped "permission-request"
/// event. Without this, Alloy style's own default is to silently deny or
/// ignore every such request — see cef_permission_handler.h.
pub fn set_permission_forwarding(app: AppHandle<Wry>) {
    let _ = APP_HANDLE.set(app);
    unsafe { strata_cef_set_permission_callback(handle_permission_callback) };
}

extern "C" fn handle_permission_callback(
    request_id: u64,
    browser_id: u64,
    origin: *const c_char,
    kind: *const c_char,
) {
    let Some(app) = APP_HANDLE.get() else { return };
    let Some(label) = browser_windows().lock().unwrap().get(&browser_id).cloned() else {
        return;
    };
    let event = PermissionEvent {
        id: request_id,
        origin: cstr_ptr_to_string(origin),
        kind: cstr_ptr_to_string(kind),
    };
    let _ = app.emit_to(label, "permission-request", event);
}

/// Answers a pending permission request — see set_permission_forwarding.
pub fn respond_permission(request_id: u64, allow: bool) {
    unsafe { strata_cef_respond_permission(request_id, allow as c_int) }
}

fn cstr_ptr_to_string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    // Safety: strata_client.cpp always passes nul-terminated strings valid
    // for the duration of this call.
    unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
}

pub fn create_browser(
    parent_hwnd: *mut c_void,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    url: &str,
    is_private: bool,
    cache_path: Option<&std::path::Path>,
) -> u64 {
    let c_url = CString::new(url).unwrap_or_default();
    // None means "use CEF's own global default context" — see
    // strata_bridge.cpp's strata_cef_create_browser, which treats a null
    // cache_path pointer that way rather than as an empty-string path.
    let c_cache_path = cache_path.map(|p| CString::new(p.to_string_lossy().as_bytes()).unwrap_or_default());
    unsafe {
        strata_cef_create_browser(
            parent_hwnd,
            x,
            y,
            width,
            height,
            c_url.as_ptr(),
            is_private as c_int,
            c_cache_path.as_ref().map_or(std::ptr::null(), |p| p.as_ptr()),
        )
    }
}

pub fn resize_browser(browser_id: u64, x: i32, y: i32, width: i32, height: i32) {
    unsafe { strata_cef_resize_browser(browser_id, x, y, width, height) }
}

pub fn set_visible(browser_id: u64, visible: bool) {
    unsafe { strata_cef_set_visible(browser_id, visible as c_int) }
}

pub fn navigate(browser_id: u64, url: &str) {
    let c_url = CString::new(url).unwrap_or_default();
    unsafe { strata_cef_navigate(browser_id, c_url.as_ptr()) }
}

pub fn go_back(browser_id: u64) {
    unsafe { strata_cef_go_back(browser_id) }
}

pub fn go_forward(browser_id: u64) {
    unsafe { strata_cef_go_forward(browser_id) }
}

pub fn reload(browser_id: u64) {
    unsafe { strata_cef_reload(browser_id) }
}

pub fn close_browser(browser_id: u64) {
    unsafe { strata_cef_close_browser(browser_id) }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabState {
    pub url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub is_loading: bool,
    pub favicon_url: Option<String>,
    pub scroll_x: f64,
    pub scroll_y: f64,
}

pub fn get_tab_state(browser_id: u64) -> Option<TabState> {
    const BUF_LEN: usize = 4096;
    let mut url_buf = vec![0u8; BUF_LEN];
    let mut title_buf = vec![0u8; BUF_LEN];
    let mut favicon_buf = vec![0u8; BUF_LEN];
    let mut raw = TabStateRaw::default();

    let ok = unsafe {
        strata_cef_get_tab_state(
            browser_id,
            &mut raw as *mut TabStateRaw,
            url_buf.as_mut_ptr() as *mut c_char,
            BUF_LEN as c_int,
            title_buf.as_mut_ptr() as *mut c_char,
            BUF_LEN as c_int,
            favicon_buf.as_mut_ptr() as *mut c_char,
            BUF_LEN as c_int,
        )
    };
    if ok == 0 {
        return None;
    }

    let favicon_url = cstr_buf_to_string(&favicon_buf);

    Some(TabState {
        url: cstr_buf_to_string(&url_buf),
        title: cstr_buf_to_string(&title_buf),
        can_go_back: raw.can_go_back != 0,
        can_go_forward: raw.can_go_forward != 0,
        is_loading: raw.is_loading != 0,
        favicon_url: (!favicon_url.is_empty()).then_some(favicon_url),
        scroll_x: raw.scroll_x,
        scroll_y: raw.scroll_y,
    })
}

fn cstr_buf_to_string(buf: &[u8]) -> String {
    let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..len]).into_owned()
}

/// Call once, after every browser has closed, right before process exit —
/// and directly (not via `run_cef`), from `RunEvent::Exit`, which already
/// fires on the correct thread.
pub fn shutdown() {
    unsafe { strata_cef_shutdown() }
}
