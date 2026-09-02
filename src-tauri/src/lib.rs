pub mod cef_bridge;

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use cef_bridge::run_cef;
use tauri::{Manager, PhysicalPosition, PhysicalSize, Rect, WindowEvent};

// Fixed chrome height in CSS pixels (title bar h-8 + tab bar h-11 + nav bar
// h-12 in frontend/src/App.tsx, at the default 16px root font size) — the
// content area, and the CEF browser embedded into it, start below this.
// TODO(Phase 2+): have the frontend report its actual chrome height instead
// of duplicating the number here; a redesign of App.tsx's rows would
// otherwise silently desync this and misplace the content area.
const CHROME_HEIGHT_LOGICAL: f64 = 32.0 + 44.0 + 48.0;

#[derive(Default)]
struct BrowserState {
    known_browsers: Mutex<HashSet<u64>>,
    active_browser: Mutex<Option<u64>>,
}

/// (window width, chrome height, content height) in physical pixels for the
/// main window's current size/scale factor.
fn layout_metrics(window: &tauri::WebviewWindow) -> (u32, u32, u32) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window
        .inner_size()
        .unwrap_or(PhysicalSize::new(1280, 840));
    let chrome_height = (CHROME_HEIGHT_LOGICAL * scale).round() as u32;
    let content_height = size.height.saturating_sub(chrome_height);
    (size.width, chrome_height, content_height)
}

fn resize_chrome_webview(window: &tauri::WebviewWindow) {
    let (width, chrome_height, _) = layout_metrics(window);
    // WebviewWindow bundles a Window + its default same-labeled Webview;
    // AsRef reaches the latter without needing Tauri's "unstable" feature
    // (which is what Manager::get_webview requires).
    let webview: &tauri::Webview<_> = window.as_ref();
    let _ = webview.set_bounds(Rect {
        position: PhysicalPosition::new(0, 0).into(),
        size: PhysicalSize::new(width, chrome_height).into(),
    });
}

fn content_bounds(window: &tauri::WebviewWindow) -> (i32, i32, i32, i32) {
    let (width, chrome_height, content_height) = layout_metrics(window);
    (0, chrome_height as i32, width as i32, content_height as i32)
}

#[tauri::command]
fn create_tab(
    app: tauri::AppHandle,
    state: tauri::State<BrowserState>,
    url: String,
) -> u64 {
    let window = app.get_webview_window("main").expect("main window exists");
    let (x, y, w, h) = content_bounds(&window);
    let hwnd_raw = window.hwnd().expect("main window has a native handle").0 as isize;

    let browser_id = run_cef(&app, move || {
        cef_bridge::create_browser(hwnd_raw as *mut std::ffi::c_void, x, y, w, h, &url)
    });

    state.known_browsers.lock().unwrap().insert(browser_id);
    browser_id
}

#[tauri::command]
fn close_tab(app: tauri::AppHandle, state: tauri::State<BrowserState>, browser_id: u64) {
    state.known_browsers.lock().unwrap().remove(&browser_id);
    {
        let mut active = state.active_browser.lock().unwrap();
        if *active == Some(browser_id) {
            *active = None;
        }
    }
    run_cef(&app, move || cef_bridge::close_browser(browser_id));
}

#[tauri::command]
fn activate_tab(app: tauri::AppHandle, state: tauri::State<BrowserState>, browser_id: u64) {
    let window = app.get_webview_window("main").expect("main window exists");
    let (x, y, w, h) = content_bounds(&window);
    let previous = state.active_browser.lock().unwrap().replace(browser_id);

    run_cef(&app, move || {
        if let Some(prev_id) = previous {
            if prev_id != browser_id {
                cef_bridge::set_visible(prev_id, false);
            }
        }
        cef_bridge::resize_browser(browser_id, x, y, w, h);
        cef_bridge::set_visible(browser_id, true);
    });
}

#[tauri::command]
fn navigate(app: tauri::AppHandle, browser_id: u64, url: String) {
    run_cef(&app, move || cef_bridge::navigate(browser_id, &url));
}

#[tauri::command]
fn go_back(app: tauri::AppHandle, browser_id: u64) {
    run_cef(&app, move || cef_bridge::go_back(browser_id));
}

#[tauri::command]
fn go_forward(app: tauri::AppHandle, browser_id: u64) {
    run_cef(&app, move || cef_bridge::go_forward(browser_id));
}

#[tauri::command]
fn reload_tab(app: tauri::AppHandle, browser_id: u64) {
    run_cef(&app, move || cef_bridge::reload(browser_id));
}

#[tauri::command]
fn get_tab_state(app: tauri::AppHandle, browser_id: u64) -> Option<cef_bridge::TabState> {
    run_cef(&app, move || cef_bridge::get_tab_state(browser_id))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Runs on this thread, which is about to become both Tauri's
    // main/event-loop thread AND (per CefSettings.multi_threaded_message_loop
    // = false, set in strata_bridge.cpp) CEF's UI thread — see cef_bridge.rs.
    if !cef_bridge::initialize() {
        panic!("CEF failed to initialize");
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(BrowserState::default())
        .invoke_handler(tauri::generate_handler![
            create_tab,
            close_tab,
            activate_tab,
            navigate,
            go_back,
            go_forward,
            reload_tab,
            get_tab_state,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window exists");
            resize_chrome_webview(&window);

            let app_handle = app.handle().clone();
            let resize_window = window.clone();
            window.on_window_event(move |event| {
                if !matches!(event, WindowEvent::Resized(_)) {
                    return;
                }
                resize_chrome_webview(&resize_window);

                let (x, y, w, h) = content_bounds(&resize_window);
                let state = app_handle.state::<BrowserState>();
                let ids: Vec<u64> = state.known_browsers.lock().unwrap().iter().copied().collect();
                run_cef(&app_handle, move || {
                    for id in ids {
                        cef_bridge::resize_browser(id, x, y, w, h);
                    }
                });
            });

            // CEF gets no other opportunity to run browser-process work in
            // this configuration (see strata_bridge.h) — pump it at a
            // steady ~60Hz, independent of Tauri's own event-driven cadence
            // (which would otherwise leave CEF idle whenever nothing else
            // is happening in the window).
            let pump_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(16));
                if pump_handle
                    .run_on_main_thread(cef_bridge::do_message_loop_work)
                    .is_err()
                {
                    break; // App is shutting down.
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            cef_bridge::shutdown();
        }
    });
}
