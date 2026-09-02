#ifndef STRATA_APP_H_
#define STRATA_APP_H_

#include "include/cef_app.h"

// Phase 0 minimal CefApp. Every CEF process (browser, renderer, GPU, utility)
// re-executes this same binary and constructs one of these; all of CefApp's
// hooks (custom scheme registration, browser-process handler, etc.) default
// to no-ops until later phases need them. Kept intentionally empty for the
// native-foundation spike — see TRD §1.
class StrataApp : public CefApp {
 public:
  StrataApp();

  StrataApp(const StrataApp&) = delete;
  StrataApp& operator=(const StrataApp&) = delete;

 private:
  IMPLEMENT_REFCOUNTING(StrataApp);
};

#endif  // STRATA_APP_H_
