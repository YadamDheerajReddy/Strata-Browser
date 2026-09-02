// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Must be the literal first thing that runs. CEF re-executes this exact
    // binary for every renderer/GPU/utility subprocess it needs, and this
    // call is how those invocations are recognized — before Tauri, before
    // any window or allocation, before anything. See
    // native/cef_bridge/include/strata_bridge.h and cef_bridge.rs.
    if let Some(exit_code) = strata_lib::cef_bridge::execute_process_if_subprocess() {
        std::process::exit(exit_code);
    }

    strata_lib::run();
}
