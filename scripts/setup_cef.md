# Setting up the CEF binary distribution

The `cef/` directory is not committed to git — it's a ~170MB download and a
few hundred MB more once extracted. Anyone building Strata natively needs to
fetch it once per machine.

**Version pinned for this project:** CEF `151.3.24+g2384915+chromium-151.0.7922.174`,
Windows 64-bit, `minimal` distribution.

## Steps (Windows)

```bash
mkdir -p cef
cd cef
curl -L "https://cef-builds.spotifycdn.com/cef_binary_151.3.24%2Bg2384915%2Bchromium-151.0.7922.174_windows64_minimal.tar.bz2" -o cef_binary.tar.bz2
tar -xjf cef_binary.tar.bz2
```

Then flatten the extracted `cef_binary_..._minimal/` folder's contents up
into `cef/` directly (so `cef/CMakeLists.txt`, `cef/cmake/`, `cef/include/`,
`cef/libcef_dll/`, `cef/Release/`, `cef/Resources/` sit right under `cef/`),
and delete `cef_binary.tar.bz2`.

## Building the Phase 0 native host

Requires Visual Studio 2022 Build Tools (Desktop development with C++
workload) and CMake 3.21+.

```bash
cmake -G "Visual Studio 17 2022" -A x64 -DUSE_SANDBOX=OFF -S native/cef_bridge -B native/cef_bridge/build
cmake --build native/cef_bridge/build --config Release
```

The built exe and all required CEF runtime files (`libcef.dll`, resource
paks, locales, etc.) land together in `native/cef_bridge/build/Release/`.
Run `strata_cef_host.exe` from that directory.

`-DUSE_SANDBOX=OFF` is a Phase 0 simplification only — the Chromium sandbox
gets configured properly before Phase 7 release hardening (see Implementation
Plan, Phase 6).

## Checking for a newer CEF version later

The full list of available builds is at
`https://cef-builds.spotifycdn.com/index.json`. Stick to the `stable`
channel. Bumping versions is a deliberate decision, not something to do
casually mid-phase — re-verify the CMake variable/macro names in
`cef/cmake/*.cmake` still match what `native/cef_bridge/CMakeLists.txt`
expects, since CEF's CMake API does shift between releases.
