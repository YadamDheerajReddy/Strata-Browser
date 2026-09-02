// Strata — Phase 0 native foundation spike.
//
// Goal (Implementation Plan, Phase 0): display a real webpage reliably
// inside the application's own native window — create browser, load URL,
// display, navigate, close — with no React/Tauri chrome involved yet.
//
// This file owns a plain Win32 window (StrataHostWindowClass) and embeds a
// CEF browser inside it as a child HWND via CefWindowInfo::SetAsChild, per
// the TRD §1 requirement that CEF render inside a window the app owns
// rather than one CEF creates and controls outright. Later phases replace
// this Win32 shell with the real Tauri-owned window; the CEF embedding
// approach carries forward unchanged.
//
// Manual navigation test hooks (since there is no address bar yet):
//   1        -> load https://example.com
//   2        -> load https://en.wikipedia.org/wiki/Chromium_(web_browser)
//   F5       -> reload
//   Alt+Left / Alt+Right -> back / forward
//   closing the window   -> clean CEF shutdown

#include <windows.h>

#include "include/cef_app.h"
#include "strata_app.h"
#include "strata_client.h"

namespace {

const wchar_t kWndClassName[] = L"StrataHostWindowClass";

// Owned for the lifetime of the process; there is exactly one browser/window
// in this Phase 0 spike.
CefRefPtr<StrataClient> g_client;

void ResizeBrowserToClientArea(HWND hwnd) {
  if (!g_client.get()) {
    return;
  }
  CefRefPtr<CefBrowser> browser = g_client->GetFirstBrowser();
  if (!browser.get()) {
    return;
  }
  const HWND browser_hwnd = browser->GetHost()->GetWindowHandle();
  if (!browser_hwnd) {
    return;
  }
  RECT client_rect;
  GetClientRect(hwnd, &client_rect);
  SetWindowPos(browser_hwnd, nullptr, 0, 0, client_rect.right - client_rect.left,
               client_rect.bottom - client_rect.top,
               SWP_NOZORDER | SWP_NOACTIVATE);
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
  switch (msg) {
    case WM_SIZE:
      ResizeBrowserToClientArea(hwnd);
      return 0;

    case WM_KEYDOWN: {
      if (!g_client.get()) {
        break;
      }
      CefRefPtr<CefBrowser> browser = g_client->GetFirstBrowser();
      if (!browser.get()) {
        break;
      }
      const bool alt_down = (GetKeyState(VK_MENU) & 0x8000) != 0;
      switch (wparam) {
        case VK_F5:
          browser->Reload();
          return 0;
        case '1':
          browser->GetMainFrame()->LoadURL("https://example.com");
          return 0;
        case '2':
          browser->GetMainFrame()->LoadURL(
              "https://en.wikipedia.org/wiki/Chromium_(web_browser)");
          return 0;
        case VK_LEFT:
          if (alt_down) {
            browser->GoBack();
            return 0;
          }
          break;
        case VK_RIGHT:
          if (alt_down) {
            browser->GoForward();
            return 0;
          }
          break;
        default:
          break;
      }
      break;
    }

    case WM_CLOSE: {
      if (g_client.get()) {
        CefRefPtr<CefBrowser> browser = g_client->GetFirstBrowser();
        if (browser.get()) {
          // Ask CEF to close the browser; StrataClient::OnBeforeClose will
          // quit the message loop once it's actually gone, and WM_DESTROY
          // (below) is posted from there.
          browser->GetHost()->CloseBrowser(false);
          return 0;
        }
      }
      DestroyWindow(hwnd);
      return 0;
    }

    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;

    default:
      break;
  }
  return DefWindowProcW(hwnd, msg, wparam, lparam);
}

HWND CreateHostWindow(HINSTANCE hinstance) {
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = WndProc;
  wc.hInstance = hinstance;
  wc.hIcon = LoadIcon(nullptr, IDI_APPLICATION);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  wc.lpszClassName = kWndClassName;
  RegisterClassExW(&wc);

  return CreateWindowExW(
      0, kWndClassName, L"Strata (Phase 0) — Native Foundation",
      WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 1280, 840, nullptr,
      nullptr, hinstance, nullptr);
}

}  // namespace

int APIENTRY wWinMain(HINSTANCE hinstance, HINSTANCE, LPWSTR, int cmd_show) {
  // Per-monitor DPI awareness for this CEF version is declared via the
  // executable's application manifest rather than a runtime API call —
  // revisit alongside the Phase 6 responsive-UI pass.
  CefMainArgs main_args(hinstance);
  CefRefPtr<StrataApp> app(new StrataApp);

  // CEF re-executes this same binary for renderer/GPU/utility processes with
  // extra command-line flags. When this call returns >= 0, we ARE one of
  // those subprocesses and must exit immediately without touching any of
  // the browser-process setup below.
  const int exit_code = CefExecuteProcess(main_args, app.get(), nullptr);
  if (exit_code >= 0) {
    return exit_code;
  }

  CefSettings settings;
  // Simplification for this native-foundation spike only — the Chromium
  // sandbox proper gets configured for real before Phase 7 (release
  // hardening); see Implementation Plan, Phase 6.
  settings.no_sandbox = true;
  settings.multi_threaded_message_loop = false;
  CefString(&settings.locale).FromASCII("en-US");
  // resources_dir_path / locales_dir_path are left empty, which makes CEF
  // look next to the executable — exactly where CMake's COPY_FILES step
  // places Resources/ and the locale paks.

  if (!CefInitialize(main_args, settings, app.get(), nullptr)) {
    MessageBoxW(nullptr, L"CefInitialize failed.", L"Strata", MB_ICONERROR);
    return 1;
  }

  const HWND hwnd = CreateHostWindow(hinstance);
  if (!hwnd) {
    CefShutdown();
    return 1;
  }

  ShowWindow(hwnd, cmd_show);
  UpdateWindow(hwnd);

  RECT client_rect;
  GetClientRect(hwnd, &client_rect);

  CefWindowInfo window_info;
  window_info.SetAsChild(
      hwnd, CefRect(0, 0, client_rect.right - client_rect.left,
                    client_rect.bottom - client_rect.top));

  g_client = new StrataClient();
  CefBrowserSettings browser_settings;

  CefBrowserHost::CreateBrowserSync(window_info, g_client.get(),
                                     "https://example.com", browser_settings,
                                     nullptr, nullptr);

  CefRunMessageLoop();

  g_client = nullptr;
  CefShutdown();
  return 0;
}
