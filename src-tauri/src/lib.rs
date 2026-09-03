pub mod cef_bridge;
pub mod storage;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cef_bridge::run_cef;
use storage::{Bookmark, DownloadEntry, HistoryEntry, Profile, Storage};
use tauri::{Emitter, Listener, Manager, PhysicalPosition, PhysicalSize, Rect, WindowEvent};

// Fixed chrome height in CSS pixels (title bar h-8 + tab bar h-11 + nav bar
// h-12 + bookmarks bar h-8, in frontend/src/App.tsx, at the default 16px
// root font size) — the content area, and the CEF browser embedded into
// it, start below this. BookmarksBar.tsx is always rendered at this fixed
// height (even with zero bookmarks) specifically so this constant never
// has to change at runtime — see that file's comment.
// TODO(Phase 2+): have the frontend report its actual chrome height instead
// of duplicating the number here; a redesign of App.tsx's rows would
// otherwise silently desync this and misplace the content area.
const CHROME_HEIGHT_LOGICAL: f64 = 32.0 + 44.0 + 48.0 + 32.0;

/// Per-window tab/browser bookkeeping, keyed by window label. Currently
/// there's only ever the "main" window, but keeping this keyed rather than
/// a single flat struct costs nothing and means a real second window
/// wouldn't need this part of the plumbing touched again.
#[derive(Default)]
struct WindowState {
    known_browsers: Mutex<HashSet<u64>>,
    active_browser: Mutex<Option<u64>>,
    // True while a full-window React panel (History, Downloads, ...) is
    // open — see set_panel_open. The window-resize handler needs this to
    // know whether the webview should keep covering the whole window or
    // shrink back to the chrome strip.
    panel_open: Mutex<bool>,
}

#[derive(Default)]
struct BrowserState {
    windows: Mutex<HashMap<String, Arc<WindowState>>>,
}

impl BrowserState {
    fn for_window(&self, label: &str) -> Arc<WindowState> {
        self.windows
            .lock()
            .unwrap()
            .entry(label.to_string())
            .or_insert_with(|| Arc::new(WindowState::default()))
            .clone()
    }
}

/// Local storage + the single active profile. Full profile switching
/// (Work/Development/Guest) beyond the one default every user starts with
/// (Implementation Plan Phase 2) — active_profile_id is mutable at runtime
/// so switch_profile can change which profile every bookmark/history/
/// downloads command reads and writes against, and default_profile_id is
/// the one ensure_default_profile created, which create_tab treats
/// specially (see profile_cache_path) so switching TO it never changes
/// existing browsing data's on-disk location.
struct AppData {
    storage: Storage,
    default_profile_id: String,
    active_profile_id: Mutex<String>,
}

impl AppData {
    fn profile_id(&self) -> String {
        self.active_profile_id.lock().unwrap().clone()
    }
}

/// Maps a CEF download id to the UUID of the row add_download created for
/// it — OnBeforeDownload's "started" event inserts the row, and every
/// OnDownloadUpdated after that needs to know which row to update rather
/// than inserting a new one each time (see handle_download_event).
#[derive(Default)]
struct DownloadRegistry {
    ids: Mutex<HashMap<u64, String>>,
}

/// Reacts to a "download-event" from cef_bridge (see
/// cef_bridge::set_download_forwarding) by persisting it to storage and
/// telling any open Downloads tab to refresh. Downloads started in an
/// incognito window are deliberately not persisted at all — same privacy
/// default as history (tabsStore.ts skips record_visit for private tabs),
/// and consistent with that window's own "Safe Browsing — nothing saved"
/// badge.
fn handle_download_event(app: &tauri::AppHandle, ev: cef_bridge::DownloadEvent) {
    let is_incognito = cef_bridge::window_label_for_browser(ev.browser_id)
        .map(|label| label.starts_with("incognito-"))
        .unwrap_or(false);
    if is_incognito {
        return;
    }

    let data = app.state::<AppData>();
    let registry = app.state::<DownloadRegistry>();

    match ev.state.as_str() {
        "started" => {
            if let Ok(entry) = data.storage.add_download(
                &data.profile_id(),
                &ev.url,
                &ev.file_path,
                &ev.file_name,
                None,
            ) {
                registry.ids.lock().unwrap().insert(ev.download_id, entry.id);
            }
        }
        status => {
            let db_id = registry.ids.lock().unwrap().get(&ev.download_id).cloned();
            if let Some(db_id) = db_id {
                let size = (ev.total_bytes > 0).then_some(ev.total_bytes);
                let _ = data.storage.update_download_status(&db_id, status, size);
            }
        }
    }

    let _ = app.emit("downloads-changed", ());
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
    let webview: &tauri::Webview<_> = window.as_ref();
    let _ = webview.set_bounds(Rect {
        position: PhysicalPosition::new(0, 0).into(),
        size: PhysicalSize::new(width, chrome_height).into(),
    });
}

/// Grows the webview to cover the entire window — the "panel open" layout;
/// see set_panel_open.
fn resize_webview_full(window: &tauri::WebviewWindow) {
    let size = window.inner_size().unwrap_or(PhysicalSize::new(1280, 840));
    let webview: &tauri::Webview<_> = window.as_ref();
    let _ = webview.set_bounds(Rect {
        position: PhysicalPosition::new(0, 0).into(),
        size: PhysicalSize::new(size.width, size.height).into(),
    });
}

fn content_bounds(window: &tauri::WebviewWindow) -> (i32, i32, i32, i32) {
    let (width, chrome_height, content_height) = layout_metrics(window);
    (0, chrome_height as i32, width as i32, content_height as i32)
}

/// Where a named profile's CEF data (cookies, cache, localStorage, ...)
/// lives on disk — separate from ~/.strata/strata.db, which only holds the
/// app's own bookmarks/history/downloads rows. Each profile gets its own
/// folder so switching profiles is a real isolation boundary, not just a
/// different set of history rows layered on shared browsing data.
///
/// Must be a direct child of ~/.strata/cef_root — CEF requires every
/// CefRequestContextSettings.cache_path to share a common parent
/// (CefSettings.root_cache_path, set to that same directory in
/// strata_cef_initialize/strata_bridge.cpp) or context creation fails.
fn profile_cache_path(profile_id: &str) -> std::path::PathBuf {
    dirs::home_dir()
        .expect("home directory must be resolvable")
        .join(".strata")
        .join("cef_root")
        .join(profile_id)
}

#[tauri::command]
fn create_tab(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<BrowserState>,
    data: tauri::State<AppData>,
    url: String,
    is_private: bool,
) -> u64 {
    let (x, y, w, h) = content_bounds(&window);
    let hwnd_raw = window.hwnd().expect("window has a native handle").0 as isize;
    let label = window.label().to_string();

    // The original default profile keeps using CEF's own global default
    // context (cache_path: None) exactly as every browser here always has
    // — only *additional* profiles created after it get a dedicated,
    // isolated context. Private tabs ignore all of this and always use the
    // shared in-memory-only context regardless of which profile is active.
    let profile_id = data.profile_id();
    let cache_path = (!is_private && profile_id != data.default_profile_id)
        .then(|| profile_cache_path(&profile_id));

    let browser_id = run_cef(&app, move || {
        cef_bridge::create_browser(
            hwnd_raw as *mut std::ffi::c_void,
            x,
            y,
            w,
            h,
            &url,
            is_private,
            cache_path.as_deref(),
        )
    });

    state
        .for_window(&label)
        .known_browsers
        .lock()
        .unwrap()
        .insert(browser_id);
    cef_bridge::register_browser_window(browser_id, label);
    browser_id
}

#[tauri::command]
fn close_tab(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<BrowserState>,
    browser_id: u64,
) {
    let ws = state.for_window(window.label());
    ws.known_browsers.lock().unwrap().remove(&browser_id);
    {
        let mut active = ws.active_browser.lock().unwrap();
        if *active == Some(browser_id) {
            *active = None;
        }
    }
    cef_bridge::unregister_browser_window(browser_id);
    run_cef(&app, move || cef_bridge::close_browser(browser_id));
}

#[tauri::command]
fn activate_tab(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<BrowserState>,
    browser_id: u64,
) {
    let ws = state.for_window(window.label());
    let (x, y, w, h) = content_bounds(&window);
    let previous = ws.active_browser.lock().unwrap().replace(browser_id);

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

/// Toggles between normal layout (chrome strip + CEF filling the rest) and
/// "panel" layout (React chrome covers the whole window, active browser
/// hidden) — how History/Downloads/etc. get enough screen space to render
/// in, since the React webview is otherwise confined to the chrome strip
/// and CEF's native window would sit on top of anything React tried to
/// draw below it.
#[tauri::command]
fn set_panel_open(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<BrowserState>,
    open: bool,
) {
    let ws = state.for_window(window.label());
    *ws.panel_open.lock().unwrap() = open;
    let active = *ws.active_browser.lock().unwrap();

    if open {
        resize_webview_full(&window);
        if let Some(id) = active {
            run_cef(&app, move || cef_bridge::set_visible(id, false));
        }
    } else {
        resize_chrome_webview(&window);
        let (x, y, w, h) = content_bounds(&window);
        if let Some(id) = active {
            run_cef(&app, move || {
                cef_bridge::resize_browser(id, x, y, w, h);
                cef_bridge::set_visible(id, true);
            });
        }
    }
}

/// Wires up the main window's chrome-webview sizing and CEF-browser
/// resize-on-resize behavior.
fn setup_window(app_handle: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    resize_chrome_webview(window);

    let app_handle = app_handle.clone();
    let label = window.label().to_string();
    let resize_window = window.clone();
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Resized(_)) {
            return;
        }
        let state = app_handle.state::<BrowserState>();
        let ws = state.for_window(&label);
        if *ws.panel_open.lock().unwrap() {
            // A React panel (History, Downloads, ...) is covering the
            // window; CEF browsers are hidden and don't need resizing until
            // set_panel_open(false) brings one back.
            resize_webview_full(&resize_window);
            return;
        }

        resize_chrome_webview(&resize_window);

        let (x, y, w, h) = content_bounds(&resize_window);
        let ids: Vec<u64> = ws.known_browsers.lock().unwrap().iter().copied().collect();
        run_cef(&app_handle, move || {
            for id in ids {
                cef_bridge::resize_browser(id, x, y, w, h);
            }
        });
    });
}

#[tauri::command]
fn add_bookmark(
    data: tauri::State<AppData>,
    url: String,
    title: String,
    favicon_url: Option<String>,
) -> Option<Bookmark> {
    data.storage
        .add_bookmark(&data.profile_id(), &url, &title, favicon_url.as_deref())
        .ok()
}

#[tauri::command]
fn remove_bookmark(data: tauri::State<AppData>, id: String) {
    let _ = data.storage.remove_bookmark(&id);
}

#[tauri::command]
fn list_bookmarks(data: tauri::State<AppData>) -> Vec<Bookmark> {
    data.storage.list_bookmarks(&data.profile_id()).unwrap_or_default()
}

#[tauri::command]
fn find_bookmark(data: tauri::State<AppData>, url: String) -> Option<Bookmark> {
    data.storage
        .find_bookmark_by_url(&data.profile_id(), &url)
        .ok()
        .flatten()
}

/// Called by the frontend's tab-state polling loop when it notices a tab's
/// URL settled on something new (see tabsStore.ts) — Phase 2's History is
/// built this way rather than via a proper CEF-side event callback because
/// that's exactly what Phase 3's EventRecorder is scoped to build; doing it
/// properly now would just be rebuilding the same thing twice.
#[tauri::command]
fn record_visit(
    data: tauri::State<AppData>,
    tab_id: String,
    url: String,
    title: String,
    favicon_url: Option<String>,
) {
    let _ = data.storage.add_navigation_event(
        &data.profile_id(),
        &tab_id,
        &url,
        &title,
        favicon_url.as_deref(),
    );
}

#[tauri::command]
fn list_history(data: tauri::State<AppData>, limit: i64) -> Vec<HistoryEntry> {
    data.storage
        .list_recent_history(&data.profile_id(), limit)
        .unwrap_or_default()
}

#[tauri::command]
fn clear_history(data: tauri::State<AppData>) {
    let _ = data.storage.clear_history(&data.profile_id());
}

#[tauri::command]
fn list_downloads(data: tauri::State<AppData>) -> Vec<DownloadEntry> {
    data.storage.list_downloads(&data.profile_id()).unwrap_or_default()
}

// --- Profiles (Implementation Plan Phase 2) ---

#[tauri::command]
fn current_profile(data: tauri::State<AppData>) -> Profile {
    data.storage
        .get_profile(&data.profile_id())
        .ok()
        .flatten()
        .expect("active profile must exist")
}

#[tauri::command]
fn list_profiles(data: tauri::State<AppData>) -> Vec<Profile> {
    data.storage.list_profiles().unwrap_or_default()
}

#[tauri::command]
fn create_profile(data: tauri::State<AppData>, name: String) -> Result<Profile, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Profile name can't be empty".to_string());
    }
    data.storage.create_profile(name).map_err(|e| e.to_string())
}

/// Switches which profile every subsequent bookmark/history/downloads
/// command reads and writes, and which CEF request context (cookies,
/// cache, site data) create_tab uses for the browsers it creates from now
/// on — see profile_cache_path. Doesn't touch any *existing* tabs; the
/// frontend closes and re-opens them itself once this returns, since Rust
/// has no clean way to tell React "your tab list is now meaningless."
#[tauri::command]
fn switch_profile(data: tauri::State<AppData>, id: String) -> Result<(), String> {
    data.storage
        .get_profile(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No such profile".to_string())?;
    *data.active_profile_id.lock().unwrap() = id;
    Ok(())
}

// --- Permission prompts (Implementation Plan Phase 2) ---

#[tauri::command]
fn respond_permission_request(app: tauri::AppHandle, id: u64, allow: bool) {
    run_cef(&app, move || cef_bridge::respond_permission(id, allow));
}

#[tauri::command]
fn delete_profile(data: tauri::State<AppData>, id: String) -> Result<(), String> {
    if id == data.profile_id() {
        return Err("Can't delete the profile you're currently using".to_string());
    }
    let remaining = data.storage.list_profiles().map_err(|e| e.to_string())?.len();
    if remaining <= 1 {
        return Err("Can't delete the last profile".to_string());
    }
    data.storage.delete_profile(&id).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Runs on this thread, which is about to become both Tauri's
    // main/event-loop thread AND (per CefSettings.multi_threaded_message_loop
    // = false, set in strata_bridge.cpp) CEF's UI thread — see cef_bridge.rs.
    if !cef_bridge::initialize() {
        panic!("CEF failed to initialize");
    }

    let storage = Storage::open().expect("failed to open ~/.strata/strata.db");
    let default_profile_id = storage
        .ensure_default_profile()
        .expect("failed to load/create the default profile")
        .id;

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(BrowserState::default())
        .manage(AppData {
            storage,
            active_profile_id: Mutex::new(default_profile_id.clone()),
            default_profile_id,
        })
        .manage(DownloadRegistry::default())
        .invoke_handler(tauri::generate_handler![
            create_tab,
            close_tab,
            activate_tab,
            navigate,
            go_back,
            go_forward,
            reload_tab,
            get_tab_state,
            set_panel_open,
            add_bookmark,
            remove_bookmark,
            list_bookmarks,
            find_bookmark,
            record_visit,
            list_history,
            clear_history,
            list_downloads,
            current_profile,
            list_profiles,
            create_profile,
            switch_profile,
            delete_profile,
            respond_permission_request,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window exists");
            setup_window(app.handle(), &window);

            // Chrome-level shortcuts (Ctrl+T, Ctrl+H, ...) pressed while a
            // page has keyboard focus reach us here — CEF forwards them via
            // this callback, which re-emits them as a "shortcut" event the
            // frontend listens for (see App.tsx). Shortcuts pressed while
            // the chrome webview itself has focus go straight through the
            // DOM as normal keydown events instead; both paths end up
            // calling the same frontend handler.
            cef_bridge::set_shortcut_forwarding(app.handle().clone());

            // Links that try to open a new tab/window (target="_blank",
            // window.open(), the page's own context menu) forward here
            // instead of falling through to CEF's default, undecorated
            // popup window — see strata_client.cpp's OnBeforePopup.
            cef_bridge::set_popup_forwarding(app.handle().clone());

            // Camera/microphone/location/notifications — without this,
            // Alloy style silently denies or ignores every such request
            // with no prompt at all (see cef_permission_handler.h).
            cef_bridge::set_permission_forwarding(app.handle().clone());

            // Same idea for downloads (see cef_bridge::DownloadEvent):
            // OnBeforeDownload/OnDownloadUpdated forward here as a
            // "download-event", and handle_download_event does the actual
            // persisting — this is what replaces CEF's own default
            // download UI ("going to chromium") with Strata's Downloads tab.
            cef_bridge::set_download_forwarding(app.handle().clone());
            let download_app = app.handle().clone();
            app.listen("download-event", move |event| {
                if let Ok(ev) = serde_json::from_str::<cef_bridge::DownloadEvent>(event.payload()) {
                    handle_download_event(&download_app, ev);
                }
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
