#ifndef STRATA_CLIENT_H_
#define STRATA_CLIENT_H_

#include <cstdint>
#include <deque>
#include <map>
#include <string>
#include <vector>

#include "include/cef_client.h"
#include "include/cef_context_menu_handler.h"
#include "include/cef_download_handler.h"
#include "include/cef_keyboard_handler.h"
#include "include/cef_permission_handler.h"

// Shared CefClient for every browser Strata creates — one per tab, per
// TRD §3 (TabManager owns tab lifecycle; this is the CEF-side counterpart).
// A single StrataClient instance serves all of them.
//
// Browsers are keyed by an id strata_bridge.cpp generates and hands back to
// Rust *before* the browser actually exists (see ExpectNextBrowser) — not
// by CefBrowser::GetIdentifier(). This is simply what the async
// CefBrowserHost::CreateBrowser() requires: it returns before the browser
// exists, so there's nothing to read an identifier off of yet, and
// OnAfterCreated (below) is where the real CefBrowser first becomes
// available. Requests are assumed to complete in the order they were made,
// which holds here because both CreateBrowser() calls and OnAfterCreated
// only ever happen on this app's one CEF UI thread.
//
// (Earlier investigation suspected CreateBrowserSync() of deadlocking
// against this app's manual message-loop pump and blamed a repeating
// "Timeout of new browser info response" CEF log line on it. Neither
// holds up: that log line turns out to be benign — it appears even on
// fully successful loads — and CreateBrowserSync() worked fine once tested
// in isolation. CreateBrowser() was kept anyway since it never requires
// the caller to already be on the UI thread, the safer default as more
// call sites appear in later phases.)

class StrataClient : public CefClient,
                      public CefLifeSpanHandler,
                      public CefDisplayHandler,
                      public CefLoadHandler,
                      public CefKeyboardHandler,
                      public CefDownloadHandler,
                      public CefContextMenuHandler,
                      public CefPermissionHandler {
 public:
  StrataClient();

  // CefClient methods:
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefKeyboardHandler> GetKeyboardHandler() override { return this; }
  CefRefPtr<CefDownloadHandler> GetDownloadHandler() override { return this; }
  CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override { return this; }
  CefRefPtr<CefPermissionHandler> GetPermissionHandler() override { return this; }

  // CefLifeSpanHandler methods:
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override;
  bool DoClose(CefRefPtr<CefBrowser> browser) override;
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override;
  // Without this, a target="_blank" link, window.open(), or "open in new
  // tab/window" from the context menu falls through to CEF's own default
  // popup handling — a bare native Chromium window with none of Strata's
  // chrome, which is exactly the "opens in chromium" the user is seeing.
  // Returning true and leaving windowInfo/client untouched cancels that
  // default popup outright; popup_callback_ is how the URL still gets
  // somewhere useful, as a real tab in the window that opened it.
  bool OnBeforePopup(CefRefPtr<CefBrowser> browser,
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
                      bool* no_javascript_access) override;

  // CefDisplayHandler methods:
  void OnTitleChange(CefRefPtr<CefBrowser> browser,
                      const CefString& title) override;
  void OnFaviconURLChange(CefRefPtr<CefBrowser> browser,
                           const std::vector<CefString>& icon_urls) override;

  // CefLoadHandler methods (diagnostic logging only — is_loading/can-go-back
  // /forward are queried live off CefBrowser in GetTabState rather than
  // tracked here, since CefBrowser already exposes them directly).
  void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                 CefRefPtr<CefFrame> frame,
                 int httpStatusCode) override;
  void OnLoadError(CefRefPtr<CefBrowser> browser,
                    CefRefPtr<CefFrame> frame,
                    ErrorCode errorCode,
                    const CefString& errorText,
                    const CefString& failedUrl) override;

  // CefKeyboardHandler methods. F5/Alt+Arrow are handled directly here
  // (they map to a CefBrowser call with nothing else involved). Chrome-level
  // shortcuts (Ctrl+T, Ctrl+H, ...) can't be handled directly — creating a
  // tab or opening a History panel is Rust/React's job, not C++'s — so
  // those go through shortcut_callback_ instead. Either way, returning
  // true here stops the key from also reaching the page or falling through
  // to whatever default behavior Chromium would otherwise give it, which
  // is what was causing Ctrl+T/Ctrl+L etc. to act like a raw Chromium
  // browser instead of Strata whenever a page (not the chrome webview) had
  // keyboard focus.
  bool OnPreKeyEvent(CefRefPtr<CefBrowser> browser,
                      const CefKeyEvent& event,
                      CefEventHandle os_event,
                      bool* is_keyboard_shortcut) override;

  // CefDownloadHandler methods. Without these, CEF falls back to its own
  // default download handling — a stock Chromium download UI with no
  // Strata involvement at all, which is exactly what the user is
  // complaining about ("downloads going to chromium instead of Strata").
  // Implementing both hands the whole flow to Rust/React instead: files
  // still land in the real OS Downloads folder (nothing about the actual
  // download changes), but the *record* of it becomes ours to show.
  bool OnBeforeDownload(
      CefRefPtr<CefBrowser> browser,
      CefRefPtr<CefDownloadItem> download_item,
      const CefString& suggested_name,
      CefRefPtr<CefBeforeDownloadCallback> callback) override;
  void OnDownloadUpdated(
      CefRefPtr<CefBrowser> browser,
      CefRefPtr<CefDownloadItem> download_item,
      CefRefPtr<CefDownloadItemCallback> callback) override;

  // CefContextMenuHandler methods. Alloy style's default context menu (see
  // strata_bridge.cpp's runtime_style) has "less default browser
  // functionality" than Chrome style by design — it has no built-in concept
  // of tabs at all, so it never offers "Open Link in New Tab" the way
  // Chrome style's menu did before runtime_style was set explicitly. Adding
  // it back ourselves is the trade-off for controlling how it's handled.
  void OnBeforeContextMenu(CefRefPtr<CefBrowser> browser,
                            CefRefPtr<CefFrame> frame,
                            CefRefPtr<CefContextMenuParams> params,
                            CefRefPtr<CefMenuModel> model) override;
  bool OnContextMenuCommand(CefRefPtr<CefBrowser> browser,
                             CefRefPtr<CefFrame> frame,
                             CefRefPtr<CefContextMenuParams> params,
                             int command_id,
                             EventFlags event_flags) override;

  // CefPermissionHandler methods. Alloy style's default handling for both
  // of these is to silently deny/ignore every request (see each method's
  // own doc comment in cef_permission_handler.h) — without overriding
  // them, a site asking for the camera/microphone/location/notifications
  // just gets nothing, with no prompt and no visible failure. Both hand
  // the decision to Rust/React via permission_callback_ and answer
  // asynchronously once RespondPermission is called from there.
  bool OnRequestMediaAccessPermission(
      CefRefPtr<CefBrowser> browser,
      CefRefPtr<CefFrame> frame,
      const CefString& requesting_origin,
      uint32_t requested_permissions,
      CefRefPtr<CefMediaAccessCallback> callback) override;
  bool OnShowPermissionPrompt(
      CefRefPtr<CefBrowser> browser,
      uint64_t prompt_id,
      const CefString& requesting_origin,
      uint32_t requested_permissions,
      CefRefPtr<CefPermissionPromptCallback> callback) override;

  // Called once from strata_bridge.cpp during startup. `callback` receives
  // the Strata-side id (see the class comment above) of the browser the
  // keypress came from, plus a short, stable action name ("new_tab",
  // "close_tab", "history", "downloads", "bookmark", "focus_address_bar",
  // "reload", "next_tab", "new_private_tab") whenever OnPreKeyEvent
  // recognizes a chrome-level shortcut — always on the CEF UI thread.
  static void SetShortcutCallback(
      void (*callback)(unsigned long long browser_id, const char* action));

  // Called once from strata_bridge.cpp during startup. `callback` fires from
  // OnBeforeDownload (state="started") and every OnDownloadUpdated after
  // that (state="in_progress"/"completed"/"cancelled") — see
  // strata_bridge.h for the exact parameter meanings. browser_id is which
  // tab's download this is (0 if the originating browser couldn't be
  // found), used by the Rust side to skip persisting downloads started
  // from an incognito window.
  static void SetDownloadCallback(void (*callback)(unsigned long long download_id,
                                                     unsigned long long browser_id,
                                                     const char* state,
                                                     const char* url,
                                                     const char* file_path,
                                                     const char* file_name,
                                                     long long received_bytes,
                                                     long long total_bytes));

  // Called once from strata_bridge.cpp during startup. `callback` fires from
  // OnBeforePopup with the id of the browser the link/window.open() came
  // from and the URL it wanted to open — Rust/React opens that URL as a
  // real Strata tab in the right window instead.
  static void SetPopupCallback(void (*callback)(unsigned long long browser_id,
                                                  const char* url));

  // Called once from strata_bridge.cpp during startup. `callback` fires
  // from OnRequestMediaAccessPermission/OnShowPermissionPrompt with a
  // request id (for the matching RespondPermission call), the id of the
  // browser that asked, the requesting origin, and a short human-readable
  // label for what's being asked for.
  static void SetPermissionCallback(void (*callback)(unsigned long long request_id,
                                                       unsigned long long browser_id,
                                                       const char* origin,
                                                       const char* kind));

  // Answers a pending permission request. Called from strata_bridge.cpp's
  // strata_cef_respond_permission, itself called from Rust once the user
  // picks Allow/Block in the React prompt. A no-op if request_id doesn't
  // match anything pending (already answered, or its tab/prompt is gone).
  static void RespondPermission(unsigned long long request_id, bool allow);

  // Bridge-facing helpers (called from strata_bridge.cpp, always on the
  // CEF UI thread — see strata_bridge.h):

  // Registers `id` as the identifier for the *next* browser that finishes
  // creating (OnAfterCreated pops these in FIFO order). Must be called
  // before the corresponding CreateBrowser() request, and requests are
  // assumed to complete in the order they were made — true here because
  // both the requests and OnAfterCreated only ever happen on this one
  // thread.
  void ExpectNextBrowser(int id);
  // Cleans up a pending id whose CreateBrowser() call was rejected
  // synchronously (returned false) and will therefore never reach
  // OnAfterCreated.
  void CancelExpectedBrowser(int id);

  CefRefPtr<CefBrowser> GetBrowser(int browser_id);
  bool GetTitle(int browser_id, std::string* out_title);
  bool GetFaviconUrl(int browser_id, std::string* out_url);
  void CloseBrowser(int browser_id);

 private:
  struct Entry {
    CefRefPtr<CefBrowser> browser;
    std::string title;
    std::string favicon_url;
  };

  // Reverse lookup: the Strata-side id for a CefBrowser, used wherever a
  // handler is only given the CefBrowser itself (OnTitleChange,
  // OnFaviconURLChange, OnPreKeyEvent). Returns -1 if not found (can happen
  // transiently for a browser whose OnAfterCreated hasn't run yet).
  int FindId(const CefRefPtr<CefBrowser>& browser);

  std::map<int, Entry> browsers_;
  std::deque<int> pending_ids_;

  static void (*shortcut_callback_)(unsigned long long browser_id,
                                     const char* action);
  static void (*download_callback_)(unsigned long long download_id,
                                     unsigned long long browser_id,
                                     const char* state,
                                     const char* url,
                                     const char* file_path,
                                     const char* file_name,
                                     long long received_bytes,
                                     long long total_bytes);
  static void (*popup_callback_)(unsigned long long browser_id, const char* url);
  static void (*permission_callback_)(unsigned long long request_id,
                                       unsigned long long browser_id,
                                       const char* origin,
                                       const char* kind);

  // A pending permission request, waiting on RespondPermission — exactly
  // one of the two callback members is set, matching which handler created
  // it. media_permissions is only meaningful alongside media_callback: it's
  // the exact bitmask CEF asked for, which Continue() must be given back
  // to grant everything that was requested.
  struct PendingPermission {
    CefRefPtr<CefMediaAccessCallback> media_callback;
    CefRefPtr<CefPermissionPromptCallback> prompt_callback;
    uint32_t media_permissions = 0;
  };
  static std::map<unsigned long long, PendingPermission> pending_permissions_;
  static unsigned long long next_permission_id_;

  IMPLEMENT_REFCOUNTING(StrataClient);
};

#endif  // STRATA_CLIENT_H_
