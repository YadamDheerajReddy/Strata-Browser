//! Safe Rust wrapper around native/cef_bridge (strata_cef_bridge.dll).
//!
//! Threading contract (see native/cef_bridge/include/strata_bridge.h): every
//! function here except `execute_process_if_subprocess` must run on the same
//! OS thread — the one that calls `initialize()`, which in this app is
//! Tauri's own main/event-loop thread. `run_cef` is how every call site
//! gets there safely regardless of which thread it's invoked from.

use std::ffi::{c_char, c_int, c_void, CString};
use std::sync::mpsc;
use tauri::{AppHandle, Runtime};

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
struct TabStateRaw {
    can_go_back: c_int,
    can_go_forward: c_int,
    is_loading: c_int,
}

extern "C" {
    fn strata_cef_execute_process() -> c_int;
    fn strata_cef_initialize() -> c_int;
    fn strata_cef_do_message_loop_work();
    fn strata_cef_create_browser(
        parent_hwnd: *mut c_void,
        x: c_int,
        y: c_int,
        width: c_int,
        height: c_int,
        url: *const c_char,
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

pub fn create_browser(
    parent_hwnd: *mut c_void,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    url: &str,
) -> u64 {
    let c_url = CString::new(url).unwrap_or_default();
    unsafe { strata_cef_create_browser(parent_hwnd, x, y, width, height, c_url.as_ptr()) }
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
}

pub fn get_tab_state(browser_id: u64) -> Option<TabState> {
    const BUF_LEN: usize = 4096;
    let mut url_buf = vec![0u8; BUF_LEN];
    let mut title_buf = vec![0u8; BUF_LEN];
    let mut raw = TabStateRaw::default();

    let ok = unsafe {
        strata_cef_get_tab_state(
            browser_id,
            &mut raw as *mut TabStateRaw,
            url_buf.as_mut_ptr() as *mut c_char,
            BUF_LEN as c_int,
            title_buf.as_mut_ptr() as *mut c_char,
            BUF_LEN as c_int,
        )
    };
    if ok == 0 {
        return None;
    }

    Some(TabState {
        url: cstr_buf_to_string(&url_buf),
        title: cstr_buf_to_string(&title_buf),
        can_go_back: raw.can_go_back != 0,
        can_go_forward: raw.can_go_forward != 0,
        is_loading: raw.is_loading != 0,
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
