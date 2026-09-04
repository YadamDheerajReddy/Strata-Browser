#include "strata_client.h"

#include <shlobj.h>
#include <windows.h>

#include <cstdio>
#include <filesystem>

#include "include/cef_app.h"
#include "include/wrapper/cef_helpers.h"

namespace {

// The real OS Downloads folder (C:\Users\<user>\Downloads), not some
// app-private directory — a downloaded file should end up exactly where the
// user would expect to find it outside Strata too.
std::string GetDownloadsDir() {
  PWSTR path = nullptr;
  std::string result;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Downloads, 0, nullptr, &path))) {
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
  return result;
}

// Appends " (1)", " (2)", ... before the extension until the path doesn't
// collide with an existing file — matching what every mainstream browser
// does instead of silently overwriting an earlier download of the same
// name.
std::string DedupePath(const std::string& dir, const std::string& file_name) {
  std::filesystem::path base(dir);
  std::filesystem::path candidate = base / file_name;
  if (!std::filesystem::exists(candidate)) {
    return candidate.string();
  }
  const std::filesystem::path stem = std::filesystem::path(file_name).stem();
  const std::filesystem::path ext = std::filesystem::path(file_name).extension();
  for (int i = 1; i < 1000; ++i) {
    candidate = base / (stem.string() + " (" + std::to_string(i) + ")" + ext.string());
    if (!std::filesystem::exists(candidate)) {
      return candidate.string();
    }
  }
  return candidate.string();
}

}  // namespace

void (*StrataClient::shortcut_callback_)(unsigned long long browser_id,
                                          const char* action) = nullptr;
void (*StrataClient::download_callback_)(unsigned long long download_id,
                                          unsigned long long browser_id,
                                          const char* state,
                                          const char* url,
                                          const char* file_path,
                                          const char* file_name,
                                          long long received_bytes,
                                          long long total_bytes) = nullptr;
void (*StrataClient::popup_callback_)(unsigned long long browser_id,
                                       const char* url) = nullptr;
void (*StrataClient::permission_callback_)(unsigned long long request_id,
                                            unsigned long long browser_id,
                                            const char* origin,
                                            const char* kind) = nullptr;
std::map<unsigned long long, StrataClient::PendingPermission>
    StrataClient::pending_permissions_;
// Started well above where CEF's own OnShowPermissionPrompt prompt_id
// values are ever likely to land (see OnShowPermissionPrompt, which reuses
// that id directly rather than generating its own) — avoids the two id
// spaces colliding without needing a real separate namespace for them.
unsigned long long StrataClient::next_permission_id_ = 1ULL << 32;

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
  // DoClose() only exists for Alloy style browsers (see
  // strata_bridge.cpp's runtime_style) — under the DEFAULT style this ran
  // under before, this override had no effect at all, which is exactly why
  // "return false" here looked harmless until Alloy style made it live.
  // Per CefLifeSpanHandler::DoClose's documentation: for a windowed
  // browser, returning false sends a native WM_CLOSE to the browser's
  // top-level PARENT window — our main Tauri window, since every tab's
  // browser is a WS_CHILD of it (see SetAsChild). That's "closing one tab
  // closes the whole window": every tab close was quietly asking Windows to
  // close the main window too, and nothing was there to distinguish that
  // from the user actually clicking the titlebar's close button. Returning
  // true suppresses that notification entirely — tab lifecycle is Rust/
  // React's job (close_tab/OnBeforeClose already handle real cleanup), and
  // the main window should only ever close because of its own close button.
  return true;
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

bool StrataClient::OnBeforePopup(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefFrame> frame,
    int popup_id,
    const CefString& target_url,
    const CefString& target_frame_name,
    WindowOpenDisposition target_disposition,
    bool user_gesture,
    const CefPopupFeatures& popupFeatures,
    CefWindowInfo& windowInfo,
    CefRefPtr<CefClient>& client,
    CefBrowserSettings& settings,
    CefRefPtr<CefDictionaryValue>& extra_info,
    bool* no_javascript_access) {
  CEF_REQUIRE_UI_THREAD();
  const int id = FindId(browser);
  if (popup_callback_) {
    popup_callback_(id >= 0 ? static_cast<unsigned long long>(id) : 0,
                     target_url.ToString().c_str());
  }
  // true = we're handling this ourselves; leaving windowInfo/client
  // untouched means no default popup window gets created at all.
  return true;
}

namespace {
// Alloy style's default context menu has no "Open Link in New Tab" item at
// all (see the class comment on OnBeforeContextMenu) — this is the id for
// the one we add back ourselves.
constexpr int kOpenLinkInNewTabCommandId = MENU_ID_USER_FIRST;
}  // namespace

void StrataClient::OnBeforeContextMenu(CefRefPtr<CefBrowser> browser,
                                        CefRefPtr<CefFrame> frame,
                                        CefRefPtr<CefContextMenuParams> params,
                                        CefRefPtr<CefMenuModel> model) {
  CEF_REQUIRE_UI_THREAD();
  if (params->GetLinkUrl().empty()) {
    return;
  }
  if (model->GetCount() > 0) {
    model->InsertSeparatorAt(0);
  }
  model->InsertItemAt(0, kOpenLinkInNewTabCommandId, "Open Link in New Tab");
}

bool StrataClient::OnContextMenuCommand(CefRefPtr<CefBrowser> browser,
                                         CefRefPtr<CefFrame> frame,
                                         CefRefPtr<CefContextMenuParams> params,
                                         int command_id,
                                         EventFlags event_flags) {
  CEF_REQUIRE_UI_THREAD();
  if (command_id != kOpenLinkInNewTabCommandId) {
    return false;
  }
  if (popup_callback_) {
    const int id = FindId(browser);
    popup_callback_(id >= 0 ? static_cast<unsigned long long>(id) : 0,
                     params->GetLinkUrl().ToString().c_str());
  }
  return true;
}

bool StrataClient::OnRequestMediaAccessPermission(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefFrame> frame,
    const CefString& requesting_origin,
    uint32_t requested_permissions,
    CefRefPtr<CefMediaAccessCallback> callback) {
  CEF_REQUIRE_UI_THREAD();
  if (!permission_callback_) {
    return false;
  }

  const unsigned long long id = next_permission_id_++;
  PendingPermission pending;
  pending.media_callback = callback;
  pending.media_permissions = requested_permissions;
  pending_permissions_[id] = pending;

  const bool wants_audio =
      requested_permissions & (CEF_MEDIA_PERMISSION_DEVICE_AUDIO_CAPTURE |
                                CEF_MEDIA_PERMISSION_DESKTOP_AUDIO_CAPTURE);
  const bool wants_video =
      requested_permissions & (CEF_MEDIA_PERMISSION_DEVICE_VIDEO_CAPTURE |
                                CEF_MEDIA_PERMISSION_DESKTOP_VIDEO_CAPTURE);
  const char* kind = wants_audio && wants_video ? "your camera and microphone"
                      : wants_video             ? "your camera"
                      : wants_audio             ? "your microphone"
                                                 : "media access";

  const int browser_id = FindId(browser);
  permission_callback_(id, browser_id >= 0 ? static_cast<unsigned long long>(browser_id) : 0,
                        requesting_origin.ToString().c_str(), kind);
  return true;
}

bool StrataClient::OnShowPermissionPrompt(
    CefRefPtr<CefBrowser> browser,
    uint64_t prompt_id,
    const CefString& requesting_origin,
    uint32_t requested_permissions,
    CefRefPtr<CefPermissionPromptCallback> callback) {
  CEF_REQUIRE_UI_THREAD();
  if (!permission_callback_) {
    return false;
  }

  PendingPermission pending;
  pending.prompt_callback = callback;
  pending_permissions_[prompt_id] = pending;

  const char* kind = "a permission";
  if (requested_permissions & CEF_PERMISSION_TYPE_GEOLOCATION) {
    kind = "your location";
  } else if (requested_permissions & CEF_PERMISSION_TYPE_NOTIFICATIONS) {
    kind = "to send notifications";
  } else if (requested_permissions & CEF_PERMISSION_TYPE_CLIPBOARD) {
    kind = "clipboard access";
  } else if (requested_permissions & CEF_PERMISSION_TYPE_MIDI_SYSEX) {
    kind = "MIDI device access";
  } else if (requested_permissions & CEF_PERMISSION_TYPE_IDLE_DETECTION) {
    kind = "to see when you're idle";
  }

  const int browser_id = FindId(browser);
  permission_callback_(prompt_id, browser_id >= 0 ? static_cast<unsigned long long>(browser_id) : 0,
                        requesting_origin.ToString().c_str(), kind);
  return true;
}

void StrataClient::SetPermissionCallback(
    void (*callback)(unsigned long long request_id,
                      unsigned long long browser_id,
                      const char* origin,
                      const char* kind)) {
  permission_callback_ = callback;
}

void StrataClient::RespondPermission(unsigned long long request_id, bool allow) {
  auto it = pending_permissions_.find(request_id);
  if (it == pending_permissions_.end()) {
    return;
  }
  PendingPermission pending = it->second;
  pending_permissions_.erase(it);

  if (pending.media_callback) {
    if (allow) {
      pending.media_callback->Continue(pending.media_permissions);
    } else {
      pending.media_callback->Cancel();
    }
  } else if (pending.prompt_callback) {
    pending.prompt_callback->Continue(allow ? CEF_PERMISSION_RESULT_ACCEPT
                                             : CEF_PERMISSION_RESULT_DENY);
  }
}

void StrataClient::OnTitleChange(CefRefPtr<CefBrowser> browser,
                                  const CefString& title) {
  CEF_REQUIRE_UI_THREAD();
  const int id = FindId(browser);
  if (id >= 0) {
    browsers_[id].title = title.ToString();
  }
}

void StrataClient::OnFaviconURLChange(
    CefRefPtr<CefBrowser> browser,
    const std::vector<CefString>& icon_urls) {
  CEF_REQUIRE_UI_THREAD();
  if (icon_urls.empty()) {
    return;
  }
  const int id = FindId(browser);
  if (id >= 0) {
    // The frontend loads this URL directly as a plain <img src> (fetched by
    // the chrome webview, not through CEF) — the first candidate is good
    // enough, no need to pick the "best" size.
    browsers_[id].favicon_url = icon_urls.front().ToString();
  }
}

bool StrataClient::OnProcessMessageReceived(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefFrame> frame,
    CefProcessId source_process,
    CefRefPtr<CefProcessMessage> message) {
  CEF_REQUIRE_UI_THREAD();
  if (message->GetName() != "scroll-offset-changed") {
    return false;
  }
  const int id = FindId(browser);
  if (id >= 0) {
    CefRefPtr<CefListValue> args = message->GetArgumentList();
    browsers_[id].scroll_x = args->GetDouble(0);
    browsers_[id].scroll_y = args->GetDouble(1);
  }
  return true;
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
  const bool ctrl_down = (event.modifiers & EVENTFLAG_CONTROL_DOWN) != 0;
  const bool alt_down = (event.modifiers & EVENTFLAG_ALT_DOWN) != 0;
  const bool shift_down = (event.modifiers & EVENTFLAG_SHIFT_DOWN) != 0;

  // Browser-level shortcuts CEF can just act on directly.
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

  // Chrome-level shortcuts — creating a tab, opening a panel, focusing the
  // address bar — aren't things C++ can do itself, so hand them to
  // Rust/React via the callback instead. Without this, these keys either
  // fall through to whatever default behavior Chromium gives an
  // unhandled accelerator (e.g. Ctrl+T/Ctrl+L acting like a raw Chromium
  // browser) or silently do nothing, depending on which page/state
  // currently has keyboard focus.
  if (ctrl_down && shortcut_callback_) {
    const char* action = nullptr;
    if (shift_down && event.windows_key_code == 'N') {
      action = "new_private_tab";
    } else if (shift_down && event.windows_key_code == 'R') {
      action = "open_continuum";
    } else if (shift_down && event.windows_key_code == 'M') {
      action = "save_moment";
    } else if (shift_down && event.windows_key_code == 'F') {
      action = "freeze_moment";
    } else if (!shift_down) {
      switch (event.windows_key_code) {
        case 'T':
          action = "new_tab";
          break;
        case 'W':
          action = "close_tab";
          break;
        case 'L':
          action = "focus_address_bar";
          break;
        case 'R':
          action = "reload";
          break;
        case 'D':
          action = "bookmark";
          break;
        case 'H':
          action = "history";
          break;
        case 'J':
          action = "downloads";
          break;
        case VK_TAB:
          action = "next_tab";
          break;
        case 'K':
          action = "open_command_palette";
          break;
        default:
          break;
      }
    }
    if (action) {
      const int id = FindId(browser);
      shortcut_callback_(id >= 0 ? static_cast<unsigned long long>(id) : 0,
                          action);
      return true;
    }
  }

  return false;
}

void StrataClient::SetShortcutCallback(
    void (*callback)(unsigned long long browser_id, const char* action)) {
  shortcut_callback_ = callback;
}

bool StrataClient::OnBeforeDownload(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefDownloadItem> download_item,
    const CefString& suggested_name,
    CefRefPtr<CefBeforeDownloadCallback> callback) {
  CEF_REQUIRE_UI_THREAD();
  const std::string path =
      DedupePath(GetDownloadsDir(), suggested_name.ToString());
  // false = don't show CEF's own "Save As" dialog — every mainstream
  // browser downloads straight to the Downloads folder by default and lets
  // Strata's own Downloads page (not a native dialog) be where the user
  // deals with it.
  callback->Continue(path, false);

  if (download_callback_) {
    const int id = FindId(browser);
    download_callback_(
        download_item->GetId(),
        id >= 0 ? static_cast<unsigned long long>(id) : 0, "started",
        download_item->GetURL().ToString().c_str(), path.c_str(),
        suggested_name.ToString().c_str(), 0,
        download_item->GetTotalBytes());
  }
  return true;
}

void StrataClient::OnDownloadUpdated(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefDownloadItem> download_item,
    CefRefPtr<CefDownloadItemCallback> callback) {
  CEF_REQUIRE_UI_THREAD();
  if (!download_callback_) {
    return;
  }
  const char* state = download_item->IsComplete()
                          ? "completed"
                          : download_item->IsCanceled() ? "cancelled"
                                                         : "in_progress";
  const int id = FindId(browser);
  const std::string file_name =
      std::filesystem::path(download_item->GetFullPath().ToString())
          .filename()
          .string();
  download_callback_(
      download_item->GetId(),
      id >= 0 ? static_cast<unsigned long long>(id) : 0, state,
      download_item->GetURL().ToString().c_str(),
      download_item->GetFullPath().ToString().c_str(), file_name.c_str(),
      download_item->GetReceivedBytes(), download_item->GetTotalBytes());
}

void StrataClient::SetDownloadCallback(
    void (*callback)(unsigned long long download_id,
                      unsigned long long browser_id,
                      const char* state,
                      const char* url,
                      const char* file_path,
                      const char* file_name,
                      long long received_bytes,
                      long long total_bytes)) {
  download_callback_ = callback;
}

void StrataClient::SetPopupCallback(void (*callback)(unsigned long long browser_id,
                                                       const char* url)) {
  popup_callback_ = callback;
}

int StrataClient::FindId(const CefRefPtr<CefBrowser>& browser) {
  for (auto& pair : browsers_) {
    if (pair.second.browser->IsSame(browser)) {
      return pair.first;
    }
  }
  return -1;
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

bool StrataClient::GetFaviconUrl(int browser_id, std::string* out_url) {
  auto it = browsers_.find(browser_id);
  if (it == browsers_.end()) {
    return false;
  }
  *out_url = it->second.favicon_url;
  return true;
}

bool StrataClient::GetScrollOffset(int browser_id, double* out_x, double* out_y) {
  auto it = browsers_.find(browser_id);
  if (it == browsers_.end()) {
    return false;
  }
  *out_x = it->second.scroll_x;
  *out_y = it->second.scroll_y;
  return true;
}

void StrataClient::CloseBrowser(int browser_id) {
  auto it = browsers_.find(browser_id);
  if (it == browsers_.end()) {
    return;
  }
  it->second.browser->GetHost()->CloseBrowser(false);
}
