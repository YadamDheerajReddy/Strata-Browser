#ifndef STRATA_CLIENT_H_
#define STRATA_CLIENT_H_

#include <deque>
#include <map>
#include <string>

#include "include/cef_client.h"
#include "include/cef_keyboard_handler.h"

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
                      public CefKeyboardHandler {
 public:
  StrataClient();

  // CefClient methods:
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefKeyboardHandler> GetKeyboardHandler() override { return this; }

  // CefLifeSpanHandler methods:
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override;
  bool DoClose(CefRefPtr<CefBrowser> browser) override;
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override;

  // CefDisplayHandler methods:
  void OnTitleChange(CefRefPtr<CefBrowser> browser,
                      const CefString& title) override;

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

  // CefKeyboardHandler methods — kept from the Phase 0 spike for now
  // (reload/back/forward test hooks); the real address bar and nav buttons
  // drive navigation through the bridge API instead, so this mainly still
  // matters for F5 / Alt+Arrow muscle memory until Phase 2 shortcuts land.
  bool OnPreKeyEvent(CefRefPtr<CefBrowser> browser,
                      const CefKeyEvent& event,
                      CefEventHandle os_event,
                      bool* is_keyboard_shortcut) override;

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
  void CloseBrowser(int browser_id);

 private:
  struct Entry {
    CefRefPtr<CefBrowser> browser;
    std::string title;
  };

  std::map<int, Entry> browsers_;
  std::deque<int> pending_ids_;

  IMPLEMENT_REFCOUNTING(StrataClient);
};

#endif  // STRATA_CLIENT_H_
