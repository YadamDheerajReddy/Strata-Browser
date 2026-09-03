<div align="center">
  <img src="docs/strata_logo.svg" alt="Strata" width="120" />

  # STRATA

  ### Browse in context.

  ![Platform](https://img.shields.io/badge/platform-Windows-8B7CFF?style=flat-square)
  ![Engine](https://img.shields.io/badge/engine-Chromium%20(CEF)-54D6C7?style=flat-square)
  ![Status](https://img.shields.io/badge/status-in%20development-orange?style=flat-square)
  ![Phase](https://img.shields.io/badge/phase-3%20%2F%207-8B7CFF?style=flat-square)
</div>

---

Strata is a **local-first, privacy-first desktop browser** built on real Chromium — not a wrapper around a system webview, not a fork you have to trust blindly. A native [CEF](https://bitbucket.org/chromium/cef) core renders the web; a Rust backend and a React chrome sit on top of it.

Every other browser treats a closed tab as gone. Strata doesn't. It quietly remembers the *context* you were working in — which tabs, which layout, how far you'd scrolled — so you can pick a thread back up hours or days later exactly where you left it. No account. No cloud. No sync server. Everything lives in one folder on your machine, `~/.strata/`, and nothing leaves it unless you explicitly ask it to.

This is not "AI-powered browsing." It's a browser with a memory.

## Why

Tabs are a bad filing system. The moment you close a window to reclaim your desktop, the research thread, the half-read documentation, the exact scroll position you were at — all of it is gone. Bookmarking helps, but a bookmark is a single URL, not a *workspace*. Strata's answer is **Continuum**: a silent, always-on recorder of your browsing context, and **Moments** — named, restorable snapshots of an entire workspace, tabs and layout and all.

## Features

### Core browsing
- Real Chromium rendering via CEF — full compatibility, not an approximation
- Tabs, address bar with inline search/navigate, back/forward/reload, favicons, load progress
- History and Downloads as real, dedicated pages — not a dropdown you can't resize
- Bookmarks with a persistent bookmarks bar
- Full keyboard-shortcut coverage (Ctrl+T, Ctrl+W, Ctrl+L, Ctrl+D, Ctrl+H, Ctrl+J, Ctrl+Tab, and more)
- A custom Strata home page — a search box and your recent context, nothing else

### Privacy & identity
- Private browsing tabs: nothing touches disk, ever — no history, no cookies, no Continuum events
- Multiple profiles (Personal / Work / Development / Guest), each with fully isolated cookies, cache, and local storage
- Permission prompts for camera, microphone, location, and notifications — nothing is silently granted *or* silently denied
- Everything stored locally in `~/.strata/` — no account, no server, no telemetry

### Continuum — the memory layer
- **EventRecorder** silently logs navigation as it happens — URL, title, tab, timestamp
- **StateCollector** checkpoints scroll position for every tab in the background, debounced so it never touches UI performance
- **Rewind**: a single ↶ button opens a right-anchored timeline of everywhere you've recently been, grouped by day — click an entry to jump straight back
- *(coming next)* **Moments** — save, freeze, restore, rename, and delete entire named workspaces: every tab, every split, every scroll position, exactly as you left it

### Design
- A modern, minimal interface inspired by Linear, Arc, and Raycast — not a re-skinned Chrome
- One restrained accent color, no decorative gradients, no "AI-flavored" visual language
- Motion used only to confirm state changes, never as decoration
- Dark and light themes

## How it's built

Strata's chrome (tabs, address bar, Continuum's timeline, everything you click) is a real desktop UI — not a webpage pretending to be a browser. The actual pages you visit are rendered by a genuine embedded Chromium instance, native and separate from that chrome.

```
┌─────────────────────────────┐        ┌─────────────────────────────┐
│           React UI           │        │          Native Core         │
│  TypeScript · Zustand        │        │  Rust · Tauri                │
│  Tabs, address bar, Rewind   │◄──────►│  Window/tab/profile mgmt     │
└─────────────────────────────┘  IPC   └───────────────┬─────────────┘
                                                          │ C/C++ bridge
                                                          ▼
                                                ┌───────────────────┐
                                                │   CEF · Chromium   │
                                                │  actual page render│
                                                └───────────────────┘
```

| Layer | Technology | Responsibility |
|---|---|---|
| Browser chrome | React, TypeScript, Vite, Tailwind CSS, Zustand, Framer Motion | Tabs, address bar, Continuum UI, history, bookmarks |
| Application shell | Rust + Tauri | Window management, IPC, native command surface |
| Browser engine | Chromium Embedded Framework (CEF) | Actual page rendering, navigation, JS execution |
| Native bridge | C/C++ | Connects Rust to CEF's browser-process APIs |
| Local storage | SQLite | Continuum events, Moments, bookmarks, downloads, settings — all local |

## Roadmap

Strata ships in risk-ordered phases — nothing is scheduled by calendar time, only by whether the previous phase's goal is *actually real*.

| Phase | Goal | Status |
|---|---|---|
| 0 · Native foundation | Reliably embed real Chromium in a native window | ✅ Done |
| 1 · Strata shell | A functional basic browser with real chrome | ✅ Done |
| 2 · Browser fundamentals | Daily-driver browsing: history, bookmarks, downloads, permissions, profiles, private mode | ✅ Done |
| 3 · Continuum | Silent background recording of browsing context + Rewind | ✅ Done |
| 4 · Moments | Save / freeze / restore / rename / delete a whole workspace | ⏳ Next |
| 5 · Advanced restoration | Restore split layouts, tab order, and window geometry together | ⏹ Planned |
| 6 · Polish | Animation, performance, crash recovery, accessibility | ⏹ Planned |
| 7 · Release | Signed, packaged Windows build — macOS and Linux to follow | ⏹ Planned |

## Getting started

Strata targets Windows first (see the roadmap above). You'll need the Rust toolchain, Node.js, CMake, and a CEF binary distribution matched to `native/cef_bridge`.

```bash
# Frontend
cd frontend
npm install

# Native CEF bridge (once, after placing the CEF distribution under /cef)
cmake -S native/cef_bridge -B native/cef_bridge/build
cmake --build native/cef_bridge/build --config Release

# Run the whole app
npm run tauri dev
```

CEF's own binary distribution is large and platform-specific, so it isn't committed to this repository — see `docs/` for the full spec set, including the setup notes referenced from `.gitignore`.

## Project structure

```
strata/
├── frontend/           React chrome — components, stores, hooks, types
├── src-tauri/           Rust core — browser, storage, downloads, permissions
├── native/cef_bridge/    C/C++ glue between Rust and CEF
├── cef/                  CEF binary distribution (not committed)
└── docs/                 Full product & engineering spec (SDLC, PRD, TRD, UI/UX, App Flow, Schema, Plan)
```

## Philosophy

> Layers — websites beneath tabs, tabs beneath context, context beneath Moments, Moments beneath a navigable timeline.

Strata is named for that idea. Every feature above exists to make one thing true: closing a tab should never mean losing your place.
