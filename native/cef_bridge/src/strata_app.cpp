#include "strata_app.h"

#include "include/cef_command_line.h"

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
