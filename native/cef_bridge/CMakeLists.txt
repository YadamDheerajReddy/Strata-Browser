# Strata — native/cef_bridge
#
# Builds strata_cef_bridge.dll: the C API (include/strata_bridge.h) that
# src-tauri links against and calls into to actually run CEF. This target
# used to be a standalone .exe for the Phase 0 native-foundation spike
# (create browser -> load URL -> display -> navigate -> close, proven
# working in isolation); Phase 1 turns it into a library so Tauri's Rust
# process can own the real application window and drive CEF from Rust
# instead. See TRD §1/§8.
#
# The CEF binary distribution lives in ../../cef (see TRD §8 project layout)
# and is not committed to git — it's fetched by scripts/setup_cef.md.

cmake_minimum_required(VERSION 3.21)

set(CEF_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../cef")
list(APPEND CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")

# The "minimal" CEF distribution only ships Release binaries (no Debug/), so
# this project is Release-only for now.
set(CMAKE_CONFIGURATION_TYPES "Release" CACHE STRING "" FORCE)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE "Release" CACHE STRING "" FORCE)
endif()

project(strata_cef_bridge)

set_property(GLOBAL PROPERTY USE_FOLDERS ON)

find_package(CEF REQUIRED)

SET_CEF_TARGET_OUT_DIR()

# libcef_dll_wrapper — CEF's own CMakeLists.txt, brought in unmodified.
add_subdirectory(${CEF_LIBCEF_DLL_WRAPPER_PATH} libcef_dll_wrapper)

# Logical target for the libcef.dll import library (libcef.lib) — the
# wrapper's object code calls into the cef_* C API, which is only resolved
# once this is linked into the final binary.
ADD_LOGICAL_TARGET("libcef_lib" "${CEF_LIB_DEBUG}" "${CEF_LIB_RELEASE}")

set(STRATA_BRIDGE_SRCS
  include/strata_bridge.h
  src/strata_bridge.cpp
  src/strata_app.h
  src/strata_app.cpp
  src/strata_client.h
  src/strata_client.cpp
)

add_library(strata_cef_bridge SHARED ${STRATA_BRIDGE_SRCS})
target_include_directories(strata_cef_bridge PRIVATE include)

add_dependencies(strata_cef_bridge libcef_dll_wrapper)
target_link_libraries(strata_cef_bridge libcef_lib libcef_dll_wrapper ${CEF_STANDARD_LIBS})

SET_LIBRARY_TARGET_PROPERTIES(strata_cef_bridge)

# Copy CEF's runtime binaries and resources alongside the DLL — libcef.dll,
# v8 snapshot, ICU data, locale paks, etc. src-tauri/build.rs copies all of
# this (plus strata_cef_bridge.dll itself) next to the final Tauri binary,
# since that's the executable whose directory CEF actually looks relative
# to at runtime.
COPY_FILES("strata_cef_bridge" "${CEF_BINARY_FILES}" "${CEF_BINARY_DIR}" "${CEF_TARGET_OUT_DIR}")
COPY_FILES("strata_cef_bridge" "${CEF_RESOURCE_FILES}" "${CEF_RESOURCE_DIR}" "${CEF_TARGET_OUT_DIR}")

PRINT_CEF_CONFIG()
