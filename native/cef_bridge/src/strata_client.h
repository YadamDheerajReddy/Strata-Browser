#ifndef STRATA_CLIENT_H_
#define STRATA_CLIENT_H_

#include <list>

#include "include/cef_client.h"

// Phase 0 minimal CefClient. Tracks the single browser instance so the
// native host window (main.cpp) can resize and close it, and quits the
// message loop once the last browser closes. Multi-tab bookkeeping is
// TabManager's job starting in Phase 1 (TRD §3) — this stays deliberately
// narrow to the "one browser, one window" proof of concept.
class StrataClient : public CefClient,
                      public CefLifeSpanHandler,
                      public CefDisplayHandler,
                      public CefLoadHandler {
 public:
  StrataClient();

  // CefClient methods:
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }

  // CefLifeSpanHandler methods:
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override;
  bool DoClose(CefRefPtr<CefBrowser> browser) override;
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override;

  // CefDisplayHandler methods:
  void OnTitleChange(CefRefPtr<CefBrowser> browser,
                      const CefString& title) override;

  // CefLoadHandler methods:
  void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                 CefRefPtr<CefFrame> frame,
                 int httpStatusCode) override;
  void OnLoadError(CefRefPtr<CefBrowser> browser,
                    CefRefPtr<CefFrame> frame,
                    ErrorCode errorCode,
                    const CefString& errorText,
                    const CefString& failedUrl) override;

  // Returns the tracked browser, or nullptr if none exists yet / anymore.
  CefRefPtr<CefBrowser> GetFirstBrowser();

  bool IsClosing() const { return is_closing_; }

 private:
  typedef std::list<CefRefPtr<CefBrowser>> BrowserList;
  BrowserList browser_list_;
  bool is_closing_;

  IMPLEMENT_REFCOUNTING(StrataClient);
};

#endif  // STRATA_CLIENT_H_
