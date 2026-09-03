//! Ordered, versioned schema migrations — see Backend Schema doc §6 and the
//! SDLC's "any change to the SQLite schema requires a migration file and a
//! rollback note" review gate. Applied on startup against SQLite's built-in
//! `user_version` pragma, which tracks how many of these have run.
//!
//! Each entry is (version, forward_sql, rollback_note). Forward SQL runs
//! automatically; the rollback note is documentation for a human doing a
//! manual rollback, not executed code — matching how small SQLite-backed
//! apps typically handle this without a full down-migration engine.

use rusqlite::Connection;

pub struct Migration {
    pub version: i32,
    pub sql: &'static str,
    pub rollback_note: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    sql: r#"
        -- profiles: identity & isolation boundary (Backend Schema §3).
        CREATE TABLE profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            is_ephemeral INTEGER NOT NULL DEFAULT 0,
            avatar_color TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        -- bookmarks (Backend Schema §5).
        CREATE TABLE bookmarks (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL REFERENCES profiles(id),
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            favicon_url TEXT,
            parent_id TEXT REFERENCES bookmarks(id),
            position INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_bookmarks_profile ON bookmarks(profile_id);

        -- downloads (Backend Schema §5).
        CREATE TABLE downloads (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL REFERENCES profiles(id),
            url TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_name TEXT NOT NULL,
            mime_type TEXT,
            size_bytes INTEGER,
            status TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            completed_at INTEGER
        );
        CREATE INDEX idx_downloads_profile ON downloads(profile_id);

        -- settings: key/value store, per-profile or global (Backend Schema §5).
        CREATE TABLE settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id TEXT REFERENCES profiles(id),
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX idx_settings_scope_key
            ON settings(IFNULL(profile_id, ''), key);

        -- navigation_events: append-only log powering History now and
        -- Rewind once Continuum lands in Phase 3 (Backend Schema §4).
        -- profile_id is a pragmatic Phase 2 addition — the documented
        -- schema reaches a profile via tab_id -> tabs.id -> profile_id,
        -- but the tabs/windows tables aren't needed until Phase 3/4 add
        -- Moments, and History needs per-profile scoping today.
        CREATE TABLE navigation_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id TEXT NOT NULL REFERENCES profiles(id),
            tab_id TEXT NOT NULL,
            type TEXT NOT NULL,
            url TEXT,
            title TEXT,
            metadata TEXT,
            timestamp INTEGER NOT NULL
        );
        CREATE INDEX idx_navigation_events_profile_time
            ON navigation_events(profile_id, timestamp DESC);
    "#,
    rollback_note: "DROP TABLE navigation_events, settings, downloads, bookmarks, profiles (in that order, for FK safety).",
}, Migration {
    version: 2,
    sql: r#"
        -- page_states: StateCollector's periodic checkpoints (Backend
        -- Schema §4, TRD §4's snapshot strategy). Same pragmatic deviation
        -- as navigation_events above: profile_id/tab_id are plain columns
        -- rather than routed through tabs/windows tables that don't exist
        -- yet. selected_text/focused_element/serialized_form_state are
        -- carried as nullable columns per the documented schema but not
        -- populated until a later phase actually captures page-owned
        -- state; zoom is a fixed 1.0 until a zoom feature exists to report
        -- a real value.
        CREATE TABLE page_states (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id TEXT NOT NULL REFERENCES profiles(id),
            tab_id TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT,
            favicon_url TEXT,
            scroll_x REAL NOT NULL DEFAULT 0,
            scroll_y REAL NOT NULL DEFAULT 0,
            zoom REAL NOT NULL DEFAULT 1.0,
            navigation_index INTEGER NOT NULL DEFAULT 0,
            selected_text TEXT,
            focused_element TEXT,
            serialized_form_state TEXT,
            is_checkpoint INTEGER NOT NULL DEFAULT 1,
            timestamp INTEGER NOT NULL
        );
        CREATE INDEX idx_page_states_tab_time ON page_states(tab_id, timestamp DESC);
    "#,
    rollback_note: "DROP TABLE page_states.",
}];

pub fn run(conn: &Connection) -> rusqlite::Result<()> {
    let current_version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    for migration in MIGRATIONS {
        if migration.version <= current_version {
            continue;
        }
        conn.execute_batch(migration.sql)?;
        conn.pragma_update(None, "user_version", migration.version)?;
    }

    Ok(())
}
