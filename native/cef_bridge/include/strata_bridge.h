// Strata CEF bridge — the C API the Rust/Tauri side links against.
//
// Threading contract (this is the part that matters most to get right):
// every function below except strata_cef_execute_process() must be called
// from the SAME thread, and that thread must be the one Tauri's own event
// loop runs on. That's because CefSettings.multi_threaded_message_loop is
// false (see strata_bridge.cpp), which makes CEF's "UI thread" whichever
// thread calls strata_cef_initialize() — there is no separate CEF thread to
// hop onto, and no internal marshaling happens in this bridge. The Rust
// side is responsible for calling these only via
// AppHandle::run_on_main_thread (see src-tauri/src/cef_bridge.rs).
#ifndef STRATA_BRIDGE_H_
#define STRATA_BRIDGE_H_

#ifdef __cplusplus
extern "C" {
#endif

#define STRATA_API __declspec(dllexport)

// Call as the literal first thing in the process entry point — before any
// Tauri/window/allocation setup of any kind. CEF re-executes this same
// binary for every renderer/GPU/utility subprocess it needs; this call is
// how those invocations are recognized and handled.
//
// Returns a value >= 0 if this process invocation WAS one of those
// subprocesses and has now finished running it — the caller must
// exit(return value) immediately and do nothing else.
// Returns -1 if this is the main browser process — the caller should
// continue with normal startup and call strata_cef_initialize() next.
STRATA_API int strata_cef_execute_process(void);

// Initializes CEF for the browser process. See the threading contract
// above. Returns 1 on success, 0 on failure.
STRATA_API int strata_cef_initialize(void);

// Pumps CEF's internal message loop. Call this at a steady ~60Hz from the
// same thread that called strata_cef_initialize() — CEF does not get any
// other opportunity to run browser-process work in this configuration.
// Never blocks.
STRATA_API void strata_cef_do_message_loop_work(void);

// Registers the function CEF calls whenever OnPreKeyEvent recognizes a
// chrome-level keyboard shortcut (Ctrl+T, Ctrl+H, ...) — see
// strata_client.h for the full list of action names this can pass.
// browser_id identifies which browser (and therefore which OS window, once
// more than one exists — see strata_cef_create_browser) the keypress came
// from, so Rust knows which window's frontend to forward the shortcut to.
// Call once during startup, before creating any browsers, from the same
// thread as strata_cef_initialize(). The callback itself will later be
// invoked from that same thread (inside OnPreKeyEvent), whenever a page has
// keyboard focus and the user presses one of these combinations.
STRATA_API void strata_cef_set_shortcut_callback(
    void (*callback)(unsigned long long browser_id, const char* action));

// Registers the function CEF calls to report download activity — once from
// OnBeforeDownload (state="started") and again on every subsequent update
// (state="in_progress", then "completed" or "cancelled"). download_id is
// CEF's own id for that download, stable across every call for the same
// download. browser_id identifies which tab started it (0 if unknown).
// file_path is the real path on disk (in the OS Downloads folder, already
// de-duplicated against existing files — see strata_client.cpp) that the
// file is being/was written to. Call once during startup, same thread rules
// as strata_cef_set_shortcut_callback.
STRATA_API void strata_cef_set_download_callback(
    void (*callback)(unsigned long long download_id,
                      unsigned long long browser_id,
                      const char* state,
                      const char* url,
                      const char* file_path,
                      const char* file_name,
                      long long received_bytes,
                      long long total_bytes));

// Registers the function CEF calls whenever a page tries to open a popup
// (target="_blank" link, window.open(), "open in new tab/window" from the
// context menu) — browser_id is the tab it came from, url is where it
// wanted to go. Without a registered callback (or if the frontend doesn't
// act on it), the popup is still cancelled — it just goes nowhere, which is
// still better than CEF's undecorated default popup window. Call once
// during startup, same thread rules as strata_cef_set_shortcut_callback.
STRATA_API void strata_cef_set_popup_callback(
    void (*callback)(unsigned long long browser_id, const char* url));

// Registers the function CEF calls whenever a page asks for something that
// needs the user's permission (camera, microphone, location, notifications,
// ...) — see strata_client.cpp for exactly which requests are covered.
// Without a registered callback, Alloy style's own default is to silently
// deny (media) or ignore (everything else) every such request, which is
// why sites asking for the camera/microphone previously just... did
// nothing. request_id uniquely identifies this request for the matching
// strata_cef_respond_permission call; browser_id is which tab asked;
// kind is a short human-readable label ("camera", "microphone", "camera
// and microphone", "location", "notifications", or "a permission" for
// anything else) meant to be shown directly in a prompt.
STRATA_API void strata_cef_set_permission_callback(
    void (*callback)(unsigned long long request_id,
                      unsigned long long browser_id,
                      const char* origin,
                      const char* kind));

// Answers a pending permission request from strata_cef_set_permission_callback.
// allow non-zero grants everything that was asked for; zero denies it.
// Calling this with an unknown/already-answered request_id is a silent
// no-op — the request may have already been dismissed by the page
// navigating away or the tab closing.
STRATA_API void strata_cef_respond_permission(unsigned long long request_id,
                                               int allow);

// Creates a browser embedded as a child window of parent_hwnd, filling the
// rectangle (x, y, width, height) in that parent's client coordinates
// (top-left origin), and navigates it to url. Returns a browser id (> 0)
// on success, 0 on failure. The returned id is CEF's own browser
// identifier — stable for the browser's lifetime, meaningless afterward.
//
// When is_private is non-zero, the browser uses a shared, in-memory-only
// CefRequestContext (no cache_path) instead of the global persistent one —
// its cookies/storage/cache vanish once every private browser using it has
// closed, and are never written to disk. Rust separately skips history
// recording for tabs it knows are private (see App Flow doc, Private
// Browsing). is_private takes priority over profile_cache_path below.
//
// profile_cache_path, when non-null and is_private is 0, gives this
// browser its own persistent CefRequestContext rooted at that directory —
// a real isolation boundary between named profiles (Implementation Plan
// Phase 2), not just separate rows in Strata's own history/bookmarks
// tables. Pass null to use CEF's own global default context instead, which
// is what the original default profile keeps doing (see lib.rs's
// create_tab) so its existing on-disk data never moves.
STRATA_API unsigned long long strata_cef_create_browser(
    void* parent_hwnd,
    int x,
    int y,
    int width,
    int height,
    const char* url,
    int is_private,
    const char* profile_cache_path);

// Repositions/resizes an existing browser's native window within its
// parent. Used both for window-resize handling and for tab switching
// (moving the active tab's browser into view).
STRATA_API void strata_cef_resize_browser(unsigned long long browser_id,
                                           int x,
                                           int y,
                                           int width,
                                           int height);

// Shows or hides the browser's native window without destroying it —
// TabManager's mechanism for "only the active tab is visible" (see App
// Flow doc, Everyday Browsing).
STRATA_API void strata_cef_set_visible(unsigned long long browser_id,
                                        int visible);

STRATA_API void strata_cef_navigate(unsigned long long browser_id,
                                     const char* url);
STRATA_API void strata_cef_go_back(unsigned long long browser_id);
STRATA_API void strata_cef_go_forward(unsigned long long browser_id);
STRATA_API void strata_cef_reload(unsigned long long browser_id);

// Closes and destroys a browser. Asynchronous — the underlying CEF browser
// is not necessarily gone by the time this call returns, but it will not
// be usable again via this id.
STRATA_API void strata_cef_close_browser(unsigned long long browser_id);

// Fixed-size snapshot of a browser's current navigation state. url/title
// are copied into caller-provided buffers (nul-terminated, truncated if too
// small) rather than returned as owned pointers, so there's no cross-FFI
// allocation lifetime to manage.
typedef struct {
  int can_go_back;
  int can_go_forward;
  int is_loading;
} strata_tab_state_t;

// Returns 1 and fills out_state/url_buf/title_buf/favicon_buf if
// browser_id is valid, 0 otherwise (e.g. the browser already closed).
// favicon_buf is set to an empty string until the page announces one via
// a <link rel="icon">-style tag (or never, for pages that don't) — the
// frontend loads whatever URL lands here directly as an <img src>.
STRATA_API int strata_cef_get_tab_state(unsigned long long browser_id,
                                         strata_tab_state_t* out_state,
                                         char* url_buf,
                                         int url_buf_len,
                                         char* title_buf,
                                         int title_buf_len,
                                         char* favicon_buf,
                                         int favicon_buf_len);

// Shuts CEF down. Call once, after every browser has been closed, right
// before process exit. Do not call any other function afterward.
STRATA_API void strata_cef_shutdown(void);

#ifdef __cplusplus
}
#endif

#endif  // STRATA_BRIDGE_H_
