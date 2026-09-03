//! Strata's single local datastore — `~/.strata/strata.db` (TRD §7, Backend
//! Schema §1). Fully local, no account, no server: everything here stays on
//! the user's machine unless a future sync feature explicitly opts in.

mod migrations;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub struct Storage {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub is_ephemeral: bool,
    pub avatar_color: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub url: String,
    pub title: String,
    pub favicon_url: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub timestamp: i64,
    pub favicon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadEntry {
    pub id: String,
    pub url: String,
    pub file_path: String,
    pub file_name: String,
    pub size_bytes: Option<i64>,
    pub status: String,
    pub started_at: i64,
    pub completed_at: Option<i64>,
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

impl Storage {
    /// Opens (creating if necessary) `~/.strata/strata.db` and brings its
    /// schema up to date.
    pub fn open() -> rusqlite::Result<Self> {
        let db_path = strata_db_path();
        if let Some(dir) = db_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| {
                rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN),
                    Some(format!("failed to create {}: {e}", dir.display())),
                )
            })?;
        }

        let conn = Connection::open(db_path)?;
        conn.pragma_update(None, "foreign_keys", true)?;
        migrations::run(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Returns the first profile, creating a default "Personal" one if none
    /// exist yet — App Flow doc §2: first launch needs no account/setup.
    pub fn ensure_default_profile(&self) -> rusqlite::Result<Profile> {
        let conn = self.conn.lock().unwrap();

        let existing = conn
            .query_row(
                "SELECT id, name, kind, is_ephemeral, avatar_color FROM profiles ORDER BY created_at LIMIT 1",
                [],
                Self::row_to_profile,
            )
            .optional()?;

        if let Some(profile) = existing {
            return Ok(profile);
        }

        let profile = Profile {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Personal".to_string(),
            kind: "personal".to_string(),
            is_ephemeral: false,
            avatar_color: "#8B7CFF".to_string(),
        };
        conn.execute(
            "INSERT INTO profiles (id, name, kind, is_ephemeral, avatar_color, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![profile.id, profile.name, profile.kind, profile.is_ephemeral as i64, profile.avatar_color, now_unix()],
        )?;
        Ok(profile)
    }

    fn row_to_profile(row: &rusqlite::Row) -> rusqlite::Result<Profile> {
        Ok(Profile {
            id: row.get(0)?,
            name: row.get(1)?,
            kind: row.get(2)?,
            is_ephemeral: row.get::<_, i64>(3)? != 0,
            avatar_color: row.get(4)?,
        })
    }

    /// Creates an additional named profile (Implementation Plan Phase 2:
    /// "Profiles (Personal/Work/Development/Guest)") — Personal is whatever
    /// ensure_default_profile created; this is for everything after that.
    /// avatar_color cycles through a small fixed palette rather than
    /// needing a color picker, matching the MVP's "no setup" bias.
    pub fn create_profile(&self, name: &str) -> rusqlite::Result<Profile> {
        const PALETTE: &[&str] = &["#8B7CFF", "#54D6C7", "#F2A65A", "#E8698A", "#5FA8F5"];
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM profiles", [], |row| row.get(0))?;
        let profile = Profile {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            kind: "custom".to_string(),
            is_ephemeral: false,
            avatar_color: PALETTE[(count as usize) % PALETTE.len()].to_string(),
        };
        conn.execute(
            "INSERT INTO profiles (id, name, kind, is_ephemeral, avatar_color, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![profile.id, profile.name, profile.kind, profile.is_ephemeral as i64, profile.avatar_color, now_unix()],
        )?;
        Ok(profile)
    }

    pub fn get_profile(&self, id: &str) -> rusqlite::Result<Option<Profile>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, kind, is_ephemeral, avatar_color FROM profiles WHERE id = ?1",
            params![id],
            Self::row_to_profile,
        )
        .optional()
    }

    pub fn list_profiles(&self) -> rusqlite::Result<Vec<Profile>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, kind, is_ephemeral, avatar_color FROM profiles ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], Self::row_to_profile)?;
        rows.collect()
    }

    /// Removes a profile and everything scoped to it. The caller (lib.rs's
    /// delete_profile command) is responsible for refusing to delete the
    /// last remaining profile or the currently active one — this layer just
    /// does the deletion once that's already been decided.
    pub fn delete_profile(&self, id: &str) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM navigation_events WHERE profile_id = ?1", params![id])?;
        tx.execute("DELETE FROM bookmarks WHERE profile_id = ?1", params![id])?;
        tx.execute("DELETE FROM downloads WHERE profile_id = ?1", params![id])?;
        tx.execute("DELETE FROM settings WHERE profile_id = ?1", params![id])?;
        tx.execute("DELETE FROM profiles WHERE id = ?1", params![id])?;
        tx.commit()
    }

    // --- Bookmarks ---

    pub fn add_bookmark(
        &self,
        profile_id: &str,
        url: &str,
        title: &str,
        favicon_url: Option<&str>,
    ) -> rusqlite::Result<Bookmark> {
        let conn = self.conn.lock().unwrap();
        let bookmark = Bookmark {
            id: uuid::Uuid::new_v4().to_string(),
            url: url.to_string(),
            title: title.to_string(),
            favicon_url: favicon_url.map(str::to_string),
            created_at: now_unix(),
        };
        conn.execute(
            "INSERT INTO bookmarks (id, profile_id, url, title, favicon_url, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COUNT(*) FROM bookmarks WHERE profile_id = ?2), ?6)",
            params![bookmark.id, profile_id, bookmark.url, bookmark.title, bookmark.favicon_url, bookmark.created_at],
        )?;
        Ok(bookmark)
    }

    pub fn remove_bookmark(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list_bookmarks(&self, profile_id: &str) -> rusqlite::Result<Vec<Bookmark>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, url, title, favicon_url, created_at FROM bookmarks
             WHERE profile_id = ?1 ORDER BY position ASC",
        )?;
        let rows = stmt.query_map(params![profile_id], |row| {
            Ok(Bookmark {
                id: row.get(0)?,
                url: row.get(1)?,
                title: row.get(2)?,
                favicon_url: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// The bookmark for this exact URL in this profile, if any — backs the
    /// address bar's filled/outline star state.
    pub fn find_bookmark_by_url(
        &self,
        profile_id: &str,
        url: &str,
    ) -> rusqlite::Result<Option<Bookmark>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, url, title, favicon_url, created_at FROM bookmarks
             WHERE profile_id = ?1 AND url = ?2 LIMIT 1",
            params![profile_id, url],
            |row| {
                Ok(Bookmark {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    title: row.get(2)?,
                    favicon_url: row.get(3)?,
                    created_at: row.get(4)?,
                })
            },
        )
        .optional()
    }

    // --- History (navigation_events) ---

    // favicon_url rides in the generic `metadata` column rather than a
    // dedicated one — navigation_events already has it for exactly this
    // kind of lightweight per-event extra (Backend Schema §4), and a single
    // optional string doesn't earn its own migration.
    pub fn add_navigation_event(
        &self,
        profile_id: &str,
        tab_id: &str,
        url: &str,
        title: &str,
        favicon_url: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO navigation_events (profile_id, tab_id, type, url, title, metadata, timestamp)
             VALUES (?1, ?2, 'NAVIGATION', ?3, ?4, ?5, ?6)",
            params![profile_id, tab_id, url, title, favicon_url, now_unix()],
        )?;
        Ok(())
    }

    pub fn list_recent_history(&self, profile_id: &str, limit: i64) -> rusqlite::Result<Vec<HistoryEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, url, title, timestamp, metadata FROM navigation_events
             WHERE profile_id = ?1 AND type = 'NAVIGATION'
             ORDER BY timestamp DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![profile_id, limit], |row| {
            Ok(HistoryEntry {
                id: row.get(0)?,
                url: row.get(1)?,
                title: row.get(2).unwrap_or_default(),
                timestamp: row.get(3)?,
                favicon_url: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn clear_history(&self, profile_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM navigation_events WHERE profile_id = ?1",
            params![profile_id],
        )?;
        Ok(())
    }

    // --- Downloads ---

    pub fn add_download(
        &self,
        profile_id: &str,
        url: &str,
        file_path: &str,
        file_name: &str,
        mime_type: Option<&str>,
    ) -> rusqlite::Result<DownloadEntry> {
        let conn = self.conn.lock().unwrap();
        let entry = DownloadEntry {
            id: uuid::Uuid::new_v4().to_string(),
            url: url.to_string(),
            file_path: file_path.to_string(),
            file_name: file_name.to_string(),
            size_bytes: None,
            status: "in_progress".to_string(),
            started_at: now_unix(),
            completed_at: None,
        };
        conn.execute(
            "INSERT INTO downloads (id, profile_id, url, file_path, file_name, mime_type, status, started_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![entry.id, profile_id, entry.url, entry.file_path, entry.file_name, mime_type, entry.status, entry.started_at],
        )?;
        Ok(entry)
    }

    pub fn update_download_status(
        &self,
        id: &str,
        status: &str,
        size_bytes: Option<i64>,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let completed_at = matches!(status, "completed" | "failed" | "cancelled").then(now_unix);
        conn.execute(
            "UPDATE downloads SET status = ?1, size_bytes = COALESCE(?2, size_bytes), completed_at = COALESCE(?3, completed_at) WHERE id = ?4",
            params![status, size_bytes, completed_at, id],
        )?;
        Ok(())
    }

    pub fn list_downloads(&self, profile_id: &str) -> rusqlite::Result<Vec<DownloadEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, url, file_path, file_name, size_bytes, status, started_at, completed_at
             FROM downloads WHERE profile_id = ?1 ORDER BY started_at DESC",
        )?;
        let rows = stmt.query_map(params![profile_id], |row| {
            Ok(DownloadEntry {
                id: row.get(0)?,
                url: row.get(1)?,
                file_path: row.get(2)?,
                file_name: row.get(3)?,
                size_bytes: row.get(4)?,
                status: row.get(5)?,
                started_at: row.get(6)?,
                completed_at: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    // --- Settings ---

    pub fn get_setting(&self, profile_id: Option<&str>, key: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT value FROM settings WHERE IFNULL(profile_id, '') = IFNULL(?1, '') AND key = ?2",
            params![profile_id, key],
            |row| row.get(0),
        )
        .optional()
    }

    pub fn set_setting(&self, profile_id: Option<&str>, key: &str, value: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (profile_id, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(IFNULL(profile_id, ''), key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![profile_id, key, value, now_unix()],
        )?;
        Ok(())
    }
}

fn strata_db_path() -> PathBuf {
    dirs::home_dir()
        .expect("home directory must be resolvable")
        .join(".strata")
        .join("strata.db")
}
