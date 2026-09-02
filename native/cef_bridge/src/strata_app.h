#ifndef STRATA_APP_H_
#define STRATA_APP_H_

#include "include/cef_app.h"

// Every CEF process (browser, renderer, GPU, utility) re-executes this same
// binary and constructs one of these. Most of CefApp's hooks (custom scheme
// registration, browser-process handler, etc.) stay no-ops until later
// phases need them; OnBeforeCommandLineProcessing is the exception — see
// strata_app.cpp for why.
class StrataApp : public CefApp {
 public:
  StrataApp();

  StrataApp(const StrataApp&) = delete;
  StrataApp& operator=(const StrataApp&) = delete;

  void OnBeforeCommandLineProcessing(
      const CefString& process_type,
      CefRefPtr<CefCommandLine> command_line) override;

 private:
  IMPLEMENT_REFCOUNTING(StrataApp);
};

#endif  // STRATA_APP_H_
