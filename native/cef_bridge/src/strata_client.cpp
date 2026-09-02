#include "strata_client.h"

#include <windows.h>

#include "include/cef_app.h"
#include "include/wrapper/cef_helpers.h"

StrataClient::StrataClient() {}

void StrataClient::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  if (pending_ids_.empty()) {
    // Shouldn't happen — every CreateBrowser() call is preceded by
    // ExpectNextBrowser() — but fail safe rather than crash if it does.
    return;
  }
  const int id = pending_ids_.front();
  pending_ids_.pop_front();

  Entry entry;
  entry.browser = browser;
  browsers_[id] = entry;
}

bool StrataClient::DoClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  // Allow the close to proceed; OnBeforeClose does the real cleanup. Unlike
  // the Phase 0 spike, closing a browser here never quits a message loop —
  // Tauri/Rust owns the process lifecycle now (see strata_bridge.h).
  return false;
}

void StrataClient::OnBeforeClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  for (auto it = browsers_.begin(); it != browsers_.end(); ++it) {
    if (it->second.browser->IsSame(browser)) {
      browsers_.erase(it);
      return;
    }
  }
}

void StrataClient::OnTitleChange(CefRefPtr<CefBrowser> browser,
                                  const CefString& title) {
  CEF_REQUIRE_UI_THREAD();
  for (auto& pair : browsers_) {
    if (pair.second.browser->IsSame(browser)) {
      pair.second.title = title.ToString();
      return;
    }
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
  if (event.type != KEYEVENT_RAWKEYDOWN) {
    return false;
  }
  const bool alt_down = (event.modifiers & EVENTFLAG_ALT_DOWN) != 0;
  switch (event.windows_key_code) {
    case VK_F5:
      browser->Reload();
      return true;
    case VK_LEFT:
      if (alt_down && browser->CanGoBack()) {
        browser->GoBack();
        return true;
      }
      break;
    case VK_RIGHT:
      if (alt_down && browser->CanGoForward()) {
        browser->GoForward();
        return true;
      }
      break;
    default:
      break;
  }
  return false;
}

void StrataClient::ExpectNextBrowser(int id) {
  pending_ids_.push_back(id);
}

void StrataClient::CancelExpectedBrowser(int id) {
  for (auto it = pending_ids_.begin(); it != pending_ids_.end(); ++it) {
    if (*it == id) {
      pending_ids_.erase(it);
      return;
    }
  }
}

CefRefPtr<CefBrowser> StrataClient::GetBrowser(int browser_id) {
  auto it = browsers_.find(browser_id);
  if (it == browsers_.end()) {
    return nullptr;
  }
  return it->second.browser;
}

bool StrataClient::GetTitle(int browser_id, std::string* out_title) {
  auto it = browsers_.find(browser_id);
  if (it == browsers_.end()) {
    return false;
  }
  *out_title = it->second.title;
  return true;
}

void StrataClient::CloseBrowser(int browser_id) {
  auto it = browsers_.find(browser_id);
  if (it == browsers_.end()) {
    return;
  }
  it->second.browser->GetHost()->CloseBrowser(false);
}
