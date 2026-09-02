#include "strata_client.h"

#include <windows.h>

#include <string>

#include "include/cef_app.h"
#include "include/wrapper/cef_helpers.h"

StrataClient::StrataClient() : is_closing_(false) {}

void StrataClient::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  browser_list_.push_back(browser);
}

bool StrataClient::DoClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  if (browser_list_.size() == 1) {
    is_closing_ = true;
  }
  // Allow the close to proceed; OnBeforeClose does the real cleanup.
  return false;
}

void StrataClient::OnBeforeClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  for (BrowserList::iterator it = browser_list_.begin();
       it != browser_list_.end(); ++it) {
    if ((*it)->IsSame(browser)) {
      browser_list_.erase(it);
      break;
    }
  }
  if (browser_list_.empty()) {
    CefQuitMessageLoop();
  }
}

void StrataClient::OnTitleChange(CefRefPtr<CefBrowser> browser,
                                  const CefString& title) {
  CEF_REQUIRE_UI_THREAD();
  const HWND browser_hwnd = browser->GetHost()->GetWindowHandle();
  const HWND root = GetAncestor(browser_hwnd, GA_ROOT);
  if (root) {
    const std::wstring full = L"Strata (Phase 0) — " + title.ToWString();
    SetWindowTextW(root, full.c_str());
  }
}

void StrataClient::OnLoadEnd(CefRefPtr<CefBrowser> browser,
                              CefRefPtr<CefFrame> frame,
                              int httpStatusCode) {
  CEF_REQUIRE_UI_THREAD();
  if (frame->IsMain()) {
    const std::string msg =
        "[Strata] Load finished (" + std::to_string(httpStatusCode) +
        "): " + frame->GetURL().ToString() + "\n";
    OutputDebugStringA(msg.c_str());
  }
}

void StrataClient::OnLoadError(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                ErrorCode errorCode,
                                const CefString& errorText,
                                const CefString& failedUrl) {
  CEF_REQUIRE_UI_THREAD();
  // ERR_ABORTED fires for normal, user-initiated navigation cancellations
  // (e.g. clicking a link before the previous page finished) — not a real
  // failure, so don't log it as one.
  if (errorCode == ERR_ABORTED) {
    return;
  }
  const std::string msg = "[Strata] Load error on " + failedUrl.ToString() +
                           ": " + errorText.ToString() + "\n";
  OutputDebugStringA(msg.c_str());
}

bool StrataClient::OnPreKeyEvent(CefRefPtr<CefBrowser> browser,
                                  const CefKeyEvent& event,
                                  CefEventHandle os_event,
                                  bool* is_keyboard_shortcut) {
  CEF_REQUIRE_UI_THREAD();
  // Only act on the initial "key went down" notification, not the repeats
  // or the follow-up KEYDOWN/CHAR events CEF also fires for the same press.
  if (event.type != KEYEVENT_RAWKEYDOWN) {
    return false;
  }
  const bool alt_down = (event.modifiers & EVENTFLAG_ALT_DOWN) != 0;
  switch (event.windows_key_code) {
    case VK_F5:
      browser->Reload();
      return true;
    case '1':
      browser->GetMainFrame()->LoadURL("https://example.com");
      return true;
    case '2':
      browser->GetMainFrame()->LoadURL(
          "https://en.wikipedia.org/wiki/Chromium_(web_browser)");
      return true;
    case VK_LEFT:
      if (alt_down) {
        browser->GoBack();
        return true;
      }
      break;
    case VK_RIGHT:
      if (alt_down) {
        browser->GoForward();
        return true;
      }
      break;
    default:
      break;
  }
  return false;
}

CefRefPtr<CefBrowser> StrataClient::GetFirstBrowser() {
  if (!browser_list_.empty()) {
    return browser_list_.front();
  }
  return nullptr;
}
