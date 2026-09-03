#ifndef STRATA_APP_H_
#define STRATA_APP_H_

#include "include/cef_app.h"
#include "include/cef_render_process_handler.h"

// Every CEF process (browser, renderer, GPU, utility) re-executes this same
// binary and constructs one of these. Most of CefApp's hooks (custom scheme
// registration, browser-process handler, etc.) stay no-ops until later
// phases need them; OnBeforeCommandLineProcessing and the render-process
// handler methods below are the exceptions.
class StrataApp : public CefApp, public CefRenderProcessHandler {
 public:
  StrataApp();

  StrataApp(const StrataApp&) = delete;
  StrataApp& operator=(const StrataApp&) = delete;

  void OnBeforeCommandLineProcessing(
      const CefString& process_type,
      CefRefPtr<CefCommandLine> command_line) override;

  // CefApp method — this same StrataApp instance also handles every
  // render-process callback below, in whichever subprocess CEF re-executes
  // this binary as a renderer.
  CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override {
    return this;
  }

  // Continuum's StateCollector (TRD §4) needs each page's real scroll
  // position, but this app uses windowed (non-OSR) rendering, so
  // CefRenderHandler/CefDisplayHandler's scroll callbacks are never invoked
  // — those only fire for off-screen-rendered browsers. Binding a small JS
  // function here and having the page report its own scroll position back
  // via a process message (see strata_client.cpp's
  // OnProcessMessageReceived) is the standard CEF technique for windowed
  // browsers. Runs in the renderer process, once per frame's V8 context.
  void OnContextCreated(CefRefPtr<CefBrowser> browser,
                        CefRefPtr<CefFrame> frame,
                        CefRefPtr<CefV8Context> context) override;

 private:
  IMPLEMENT_REFCOUNTING(StrataApp);
};

#endif  // STRATA_APP_H_
