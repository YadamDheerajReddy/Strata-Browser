#include "strata_app.h"

#include "include/cef_command_line.h"
#include "include/cef_process_message.h"
#include "include/cef_v8.h"

namespace {

// Backs the `window.__strataReportScroll(x, y)` function OnContextCreated
// binds into every page (renderer process) — forwards the call to the
// browser process as a "scroll-offset-changed" message, read back out in
// StrataClient::OnProcessMessageReceived.
class ReportScrollHandler : public CefV8Handler {
 public:
  bool Execute(const CefString& name,
               CefRefPtr<CefV8Value> object,
               const CefV8ValueList& arguments,
               CefRefPtr<CefV8Value>& retval,
               CefString& exception) override {
    if (arguments.size() < 2) {
      return false;
    }
    CefRefPtr<CefV8Context> context = CefV8Context::GetCurrentContext();
    CefRefPtr<CefFrame> frame = context ? context->GetFrame() : nullptr;
    if (!frame) {
      return false;
    }
    CefRefPtr<CefProcessMessage> message =
        CefProcessMessage::Create("scroll-offset-changed");
    CefRefPtr<CefListValue> args = message->GetArgumentList();
    args->SetDouble(0, arguments[0]->GetDoubleValue());
    args->SetDouble(1, arguments[1]->GetDoubleValue());
    frame->SendProcessMessage(PID_BROWSER, message);
    return true;
  }

  IMPLEMENT_REFCOUNTING(ReportScrollHandler);
};

}  // namespace

StrataApp::StrataApp() {}

void StrataApp::OnBeforeCommandLineProcessing(
    const CefString& process_type,
    CefRefPtr<CefCommandLine> command_line) {
  // This dev environment has no real GPU passthrough (VM/remote desktop),
  // which crashes CEF's GPU process repeatedly on every browser creation
  // ("GPU process exited unexpectedly"). Chromium auto-recovers by
  // reinitializing it, so this isn't fatal on its own — but forcing
  // Chromium onto its software rendering path (the same SwiftShader/
  // ANGLE-software libraries already shipped in cef/Release) avoids the
  // noisy crash/recover cycle entirely. Revisit before Phase 6 polish/perf
  // work on real hardware.
  command_line->AppendSwitch("disable-gpu");
}

void StrataApp::OnContextCreated(CefRefPtr<CefBrowser> browser,
                                  CefRefPtr<CefFrame> frame,
                                  CefRefPtr<CefV8Context> context) {
  // One scroll position per tab is enough for StateCollector's checkpoints
  // — skip binding into every iframe's own context too.
  if (!frame->IsMain()) {
    return;
  }

  CefRefPtr<CefV8Value> global = context->GetGlobal();
  CefRefPtr<CefV8Handler> handler = new ReportScrollHandler();
  CefRefPtr<CefV8Value> function =
      CefV8Value::CreateFunction("__strataReportScroll", handler);
  global->SetValue("__strataReportScroll", function, V8_PROPERTY_ATTRIBUTE_NONE);

  // rAF-coalesced so a scroll gesture reports at most once per frame rather
  // than once per input event — the Rust side throttles/writes this
  // further (see checkpoint_page_state's ~1s debounce).
  frame->ExecuteJavaScript(
      "(function() {"
      "  var ticking = false;"
      "  window.addEventListener('scroll', function() {"
      "    if (ticking) return;"
      "    ticking = true;"
      "    requestAnimationFrame(function() {"
      "      window.__strataReportScroll(window.scrollX, window.scrollY);"
      "      ticking = false;"
      "    });"
      "  }, { passive: true });"
      "})();",
      frame->GetURL(), 0);
}
