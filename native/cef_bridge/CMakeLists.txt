# Strata — native/cef_bridge
#
# Phase 0 (native foundation) target: a minimal C++ host that proves CEF can
# create a browser, load a real URL, render it inside a native window this
# application owns, navigate, and close — reliably, end to end. Per the TRD
# (§1) and SDLC (§1), no React/Tauri work is wired in until this passes.
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
# once this is linked into the final executable.
ADD_LOGICAL_TARGET("libcef_lib" "${CEF_LIB_DEBUG}" "${CEF_LIB_RELEASE}")

set(STRATA_HOST_SRCS
  src/main.cpp
  src/strata_app.h
  src/strata_app.cpp
  src/strata_client.h
  src/strata_client.cpp
)

add_executable(strata_cef_host WIN32 ${STRATA_HOST_SRCS})

add_dependencies(strata_cef_host libcef_dll_wrapper)
target_link_libraries(strata_cef_host libcef_lib libcef_dll_wrapper ${CEF_STANDARD_LIBS})

SET_EXECUTABLE_TARGET_PROPERTIES(strata_cef_host)

# Copy CEF's runtime binaries and resources alongside our exe — libcef.dll,
# v8 snapshot, ICU data, locale paks, etc. Without these the browser process
# fails to initialize.
COPY_FILES("strata_cef_host" "${CEF_BINARY_FILES}" "${CEF_BINARY_DIR}" "${CEF_TARGET_OUT_DIR}")
COPY_FILES("strata_cef_host" "${CEF_RESOURCE_FILES}" "${CEF_RESOURCE_DIR}" "${CEF_TARGET_OUT_DIR}")

PRINT_CEF_CONFIG()
