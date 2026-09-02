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

// Creates a browser embedded as a child window of parent_hwnd, filling the
// rectangle (x, y, width, height) in that parent's client coordinates
// (top-left origin), and navigates it to url. Returns a browser id (> 0)
// on success, 0 on failure. The returned id is CEF's own browser
// identifier — stable for the browser's lifetime, meaningless afterward.
STRATA_API unsigned long long strata_cef_create_browser(void* parent_hwnd,
                                                          int x,
                                                          int y,
                                                          int width,
                                                          int height,
                                                          const char* url);

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

// Returns 1 and fills out_state/url_buf/title_buf if browser_id is valid,
// 0 otherwise (e.g. the browser already closed).
STRATA_API int strata_cef_get_tab_state(unsigned long long browser_id,
                                         strata_tab_state_t* out_state,
                                         char* url_buf,
                                         int url_buf_len,
                                         char* title_buf,
                                         int title_buf_len);

// Shuts CEF down. Call once, after every browser has been closed, right
// before process exit. Do not call any other function afterward.
STRATA_API void strata_cef_shutdown(void);

#ifdef __cplusplus
}
#endif

#endif  // STRATA_BRIDGE_H_
