#include "../include/strata_bridge.h"

#include <windows.h>

#include <cstring>

#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "strata_app.h"
#include "strata_client.h"

namespace {

// Set once by strata_cef_execute_process() (every process invocation, main
// or subprocess) and reused by strata_cef_initialize() (main process only).
CefRefPtr<StrataApp> g_app;

// The single CefClient shared by every browser/tab — see strata_client.h.
// Only constructed for the main browser process, after CefInitialize.
CefRefPtr<StrataClient> g_client;

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

  if (!CefInitialize(main_args, settings, g_app.get(), nullptr)) {
    return 0;
  }

  g_client = new StrataClient();
  return 1;
}

void strata_cef_do_message_loop_work(void) {
  CefDoMessageLoopWork();
}

unsigned long long strata_cef_create_browser(void* parent_hwnd,
                                              int x,
                                              int y,
                                              int width,
                                              int height,
                                              const char* url) {
  if (!g_client) {
    return 0;
  }

  CefWindowInfo window_info;
  window_info.SetAsChild(static_cast<HWND>(parent_hwnd),
                          CefRect(x, y, width, height));

  CefBrowserSettings browser_settings;

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
      nullptr);
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
                              int title_buf_len) {
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
  }

  CopyToBuffer(browser->GetMainFrame()->GetURL().ToString(), url_buf,
               url_buf_len);

  std::string title;
  g_client->GetTitle(static_cast<int>(browser_id), &title);
  CopyToBuffer(title, title_buf, title_buf_len);

  return 1;
}

void strata_cef_shutdown(void) {
  g_client = nullptr;
  CefShutdown();
  g_app = nullptr;
}
