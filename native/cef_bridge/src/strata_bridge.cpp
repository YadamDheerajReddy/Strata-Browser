#include "../include/strata_bridge.h"

#include <shlobj.h>
#include <windows.h>

#include <cstdio>
#include <cstring>
#include <map>

#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_request_context.h"
#include "strata_app.h"
#include "strata_client.h"

namespace {

// Set once by strata_cef_execute_process() (every process invocation, main
// or subprocess) and reused by strata_cef_initialize() (main process only).
CefRefPtr<StrataApp> g_app;

// The single CefClient shared by every browser/tab — see strata_client.h.
// Only constructed for the main browser process, after CefInitialize.
CefRefPtr<StrataClient> g_client;

// Shared by every private/incognito browser. Created lazily on first use;
// left with an empty cache_path, which per CEF's own documentation puts it
// in "incognito mode" — in-memory storage only, nothing written to disk.
CefRefPtr<CefRequestContext> GetPrivateRequestContext() {
  static CefRefPtr<CefRequestContext> private_context;
  if (!private_context) {
    CefRequestContextSettings settings;
    private_context = CefRequestContext::CreateContext(settings, nullptr);
  }
  return private_context;
}

// One persistent, isolated CefRequestContext per named profile (see
// lib.rs's create_tab/profile_cache_path) — cached by cache_path so
// switching back to a profile already used this session reuses its
// context instead of creating a second, conflicting one for the same
// on-disk directory.
CefRefPtr<CefRequestContext> GetProfileRequestContext(
    const std::string& cache_path) {
  static std::map<std::string, CefRefPtr<CefRequestContext>> contexts;
  auto it = contexts.find(cache_path);
  if (it != contexts.end()) {
    return it->second;
  }
  CefRequestContextSettings settings;
  CefString(&settings.cache_path).FromString(cache_path);
  CefRefPtr<CefRequestContext> context =
      CefRequestContext::CreateContext(settings, nullptr);
  contexts[cache_path] = context;
  return context;
}

// ~/.strata/cef_root — the common parent every per-profile cache_path must
// live under (CEF's CefSettings.root_cache_path requirement; see
// strata_cef_initialize). Resolved once and reused rather than recomputed
// per browser creation.
std::string GetStrataCefRoot() {
  PWSTR path = nullptr;
  std::string result;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Profile, 0, nullptr, &path))) {
    const int len = WideCharToMultiByte(CP_UTF8, 0, path, -1, nullptr, 0,
                                         nullptr, nullptr);
    if (len > 0) {
      result.resize(len - 1);
      WideCharToMultiByte(CP_UTF8, 0, path, -1, result.data(), len, nullptr,
                           nullptr);
    }
  }
  if (path) {
    CoTaskMemFree(path);
  }
  if (!result.empty()) {
    result += "\\.strata\\cef_root";
  }
  return result;
}

void CopyToBuffer(const std::string& value, char* buf, int buf_len) {
  if (!buf || buf_len <= 0) {
    return;
  }
  const size_t n = value.copy(buf, static_cast<size_t>(buf_len - 1));
  buf[n] = '\0';
}

}  // namespace

int strata_cef_execute_process(void) {
  CefMainArgs main_args(::GetModuleHandleW(nullptr));
  g_app = new StrataApp();
  return CefExecuteProcess(main_args, g_app.get(), nullptr);
}

int strata_cef_initialize(void) {
  CefMainArgs main_args(::GetModuleHandleW(nullptr));

  CefSettings settings;
  // Phase 1 simplification, same as the Phase 0 spike — the Chromium
  // sandbox gets configured properly before Phase 7 release hardening.
  settings.no_sandbox = true;
  // Confirmed by testing both values that this isn't the cause of the
  // "Timeout of new browser info response" issue (see git history /
  // conversation log) — false matches our real architecture, where Rust
  // pumps strata_cef_do_message_loop_work() from its own event loop
  // instead of a dedicated CEF thread (see strata_bridge.h's threading
  // contract).
  settings.multi_threaded_message_loop = false;
  CefString(&settings.locale).FromASCII("en-US");
  // resources_dir_path / locales_dir_path left empty: CEF looks next to the
  // executable, which is where the build copies Resources/ and locales/
  // (see src-tauri/build.rs).

  // Every per-profile CefRequestContextSettings.cache_path (see
  // GetProfileRequestContext) must share this as a common parent directory
  // — CEF enforces this and fails to create the context otherwise. Leaving
  // CefSettings.cache_path itself unset keeps the original default
  // profile's browsers behaving exactly as they always have.
  const std::string cef_root = GetStrataCefRoot();
  if (!cef_root.empty()) {
    CefString(&settings.root_cache_path).FromString(cef_root);
  }

  if (!CefInitialize(main_args, settings, g_app.get(), nullptr)) {
    return 0;
  }

  g_client = new StrataClient();
  return 1;
}

void strata_cef_do_message_loop_work(void) {
  CefDoMessageLoopWork();
}

void strata_cef_set_shortcut_callback(
    void (*callback)(unsigned long long browser_id, const char* action)) {
  StrataClient::SetShortcutCallback(callback);
}

void strata_cef_set_download_callback(
    void (*callback)(unsigned long long download_id,
                      unsigned long long browser_id,
                      const char* state,
                      const char* url,
                      const char* file_path,
                      const char* file_name,
                      long long received_bytes,
                      long long total_bytes)) {
  StrataClient::SetDownloadCallback(callback);
}

void strata_cef_set_popup_callback(
    void (*callback)(unsigned long long browser_id, const char* url)) {
  StrataClient::SetPopupCallback(callback);
}

void strata_cef_set_permission_callback(
    void (*callback)(unsigned long long request_id,
                      unsigned long long browser_id,
                      const char* origin,
                      const char* kind)) {
  StrataClient::SetPermissionCallback(callback);
}

void strata_cef_respond_permission(unsigned long long request_id, int allow) {
  StrataClient::RespondPermission(request_id, allow != 0);
}

unsigned long long strata_cef_create_browser(void* parent_hwnd,
                                              int x,
                                              int y,
                                              int width,
                                              int height,
                                              const char* url,
                                              int is_private,
                                              const char* profile_cache_path) {
  if (!g_client) {
    return 0;
  }

  CefWindowInfo window_info;
  window_info.SetAsChild(static_cast<HWND>(parent_hwnd),
                          CefRect(x, y, width, height));
  // SetAsChild() includes WS_VISIBLE by default, so without this every
  // browser would be visible — on top, at its full rect — from the instant
  // its native window is created, well before Rust/React ever get a chance
  // to decide whether it should be (activate_tab's explicit set_visible
  // call only runs after an async round-trip through Rust and back). That
  // race let a background-created browser (e.g. RestoreManager creating
  // several tabs back-to-back — Implementation Plan Phase 4) flash on top
  // of whatever tab was actually active. Every real code path already
  // calls strata_cef_set_visible(true) once a browser should actually be
  // shown (see activate_tab in lib.rs), so starting hidden costs nothing.
  window_info.style &= ~static_cast<DWORD>(WS_VISIBLE);
  // This whole app is built on Alloy-style assumptions — raw child-window
  // embedding, StrataClient's CefLifeSpanHandler/CefKeyboardHandler
  // callbacks (OnPreKeyEvent, OnBeforePopup, ...) instead of Chrome's own
  // built-in UI. Leaving runtime_style at its default let CEF pick Chrome
  // style for these windowed/child-parented browsers, which handles
  // "open link in new tab" (and likely other things) through its own
  // internal Browser/TabStripModel machinery instead of ever calling
  // OnBeforePopup — explaining why that override never fired no matter
  // what it did. Forcing Alloy style here is what makes it fire at all.
  window_info.runtime_style = CEF_RUNTIME_STYLE_ALLOY;

  CefBrowserSettings browser_settings;
  CefRefPtr<CefRequestContext> request_context;
  if (is_private) {
    request_context = GetPrivateRequestContext();
  } else if (profile_cache_path && profile_cache_path[0] != '\0') {
    request_context = GetProfileRequestContext(profile_cache_path);
  }

  // The async CreateBrowser(), not CreateBrowserSync() — both were
  // confirmed to work equally well once an unrelated red herring
  // ("Timeout of new browser info response", a benign CEF log line that
  // turns out to appear even on fully successful loads) was ruled out, but
  // async never requires the caller to already be on the UI thread, which
  // is the safer default as more call sites appear in later phases.
  static unsigned long long next_id = 1;
  const unsigned long long id = next_id++;

  g_client->ExpectNextBrowser(static_cast<int>(id));
  const bool queued = CefBrowserHost::CreateBrowser(
      window_info, g_client, url ? url : "", browser_settings, nullptr,
      request_context);
  if (!queued) {
    g_client->CancelExpectedBrowser(static_cast<int>(id));
    return 0;
  }
  return id;
}

void strata_cef_resize_browser(unsigned long long browser_id,
                                int x,
                                int y,
                                int width,
                                int height) {
  if (!g_client) {
    return;
  }
  CefRefPtr<CefBrowser> browser =
      g_client->GetBrowser(static_cast<int>(browser_id));
  if (!browser) {
    return;
  }
  const HWND hwnd = browser->GetHost()->GetWindowHandle();
  if (hwnd) {
    SetWindowPos(hwnd, nullptr, x, y, width, height,
                 SWP_NOZORDER | SWP_NOACTIVATE);
  }
}

void strata_cef_set_visible(unsigned long long browser_id, int visible) {
  if (!g_client) {
    return;
  }
  CefRefPtr<CefBrowser> browser =
      g_client->GetBrowser(static_cast<int>(browser_id));
  if (!browser) {
    return;
  }
  const HWND hwnd = browser->GetHost()->GetWindowHandle();
  if (hwnd) {
    ShowWindow(hwnd, visible ? SW_SHOW : SW_HIDE);
  }
}

void strata_cef_navigate(unsigned long long browser_id, const char* url) {
  if (!g_client || !url) {
    return;
  }
  CefRefPtr<CefBrowser> browser =
      g_client->GetBrowser(static_cast<int>(browser_id));
  if (browser) {
    browser->GetMainFrame()->LoadURL(url);
  }
}

void strata_cef_go_back(unsigned long long browser_id) {
  if (!g_client) {
    return;
  }
  CefRefPtr<CefBrowser> browser =
      g_client->GetBrowser(static_cast<int>(browser_id));
  if (browser && browser->CanGoBack()) {
    browser->GoBack();
  }
}

void strata_cef_go_forward(unsigned long long browser_id) {
  if (!g_client) {
    return;
  }
  CefRefPtr<CefBrowser> browser =
      g_client->GetBrowser(static_cast<int>(browser_id));
  if (browser && browser->CanGoForward()) {
    browser->GoForward();
  }
}

void strata_cef_reload(unsigned long long browser_id) {
  if (!g_client) {
    return;
  }
  CefRefPtr<CefBrowser> browser =
      g_client->GetBrowser(static_cast<int>(browser_id));
  if (browser) {
    browser->Reload();
  }
}

void strata_cef_close_browser(unsigned long long browser_id) {
  if (!g_client) {
    return;
  }
  g_client->CloseBrowser(static_cast<int>(browser_id));
}

int strata_cef_get_tab_state(unsigned long long browser_id,
                              strata_tab_state_t* out_state,
                              char* url_buf,
                              int url_buf_len,
                              char* title_buf,
                              int title_buf_len,
                              char* favicon_buf,
                              int favicon_buf_len) {
  if (!g_client) {
    return 0;
  }
  CefRefPtr<CefBrowser> browser =
      g_client->GetBrowser(static_cast<int>(browser_id));
  if (!browser) {
    return 0;
  }

  if (out_state) {
    out_state->can_go_back = browser->CanGoBack() ? 1 : 0;
    out_state->can_go_forward = browser->CanGoForward() ? 1 : 0;
    out_state->is_loading = browser->IsLoading() ? 1 : 0;
    double scroll_x = 0.0, scroll_y = 0.0;
    g_client->GetScrollOffset(static_cast<int>(browser_id), &scroll_x, &scroll_y);
    out_state->scroll_x = scroll_x;
    out_state->scroll_y = scroll_y;
  }

  CopyToBuffer(browser->GetMainFrame()->GetURL().ToString(), url_buf,
               url_buf_len);

  std::string title;
  g_client->GetTitle(static_cast<int>(browser_id), &title);
  CopyToBuffer(title, title_buf, title_buf_len);

  std::string favicon_url;
  g_client->GetFaviconUrl(static_cast<int>(browser_id), &favicon_url);
  CopyToBuffer(favicon_url, favicon_buf, favicon_buf_len);

  return 1;
}

void strata_cef_scroll_to(unsigned long long browser_id, double x, double y) {
  if (!g_client) {
    return;
  }
  CefRefPtr<CefBrowser> browser =
      g_client->GetBrowser(static_cast<int>(browser_id));
  if (!browser) {
    return;
  }
  CefRefPtr<CefFrame> frame = browser->GetMainFrame();
  char script[128];
  snprintf(script, sizeof(script), "window.scrollTo(%f, %f);", x, y);
  frame->ExecuteJavaScript(script, frame->GetURL(), 0);
}

void strata_cef_shutdown(void) {
  g_client = nullptr;
  CefShutdown();
  g_app = nullptr;
}
