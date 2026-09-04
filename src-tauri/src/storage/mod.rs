//! Strata's single local datastore — `~/.strata/strata.db` (TRD §7, Backend
//! Schema §1). Fully local, no account, no server: everything here stays on
//! the user's machine unless a future sync feature explicitly opts in.

mod migrations;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

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

// --- Moments (Implementation Plan Phase 4) ---

/// One captured tab, as sent up from the frontend at save/freeze time —
/// tab_id is the frontend's ephemeral tab id (meaningless after restart,
/// but harmless to record alongside the MOMENT_SAVED/MOMENT_FROZEN
/// navigation_event it produces, same as navigation_events already does).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MomentTabInput {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub favicon_url: Option<String>,
    pub scroll_x: f64,
    pub scroll_y: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MomentTabSummary {
    pub url: String,
    pub title: String,
    pub favicon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moment {
    pub id: String,
    pub name: String,
    pub tab_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub tabs: Vec<MomentTabSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MomentTabDetail {
    pub url: String,
    pub title: String,
    pub favicon_url: Option<String>,
    pub scroll_x: f64,
    pub scroll_y: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MomentDetail {
    pub id: String,
    pub name: String,
    pub tabs: Vec<MomentTabDetail>,
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
        tx.execute(
            "DELETE FROM moment_events WHERE moment_id IN (SELECT id FROM moments WHERE profile_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM moment_tabs WHERE moment_id IN (SELECT id FROM moments WHERE profile_id = ?1)",
            params![id],
        )?;
        tx.execute("DELETE FROM moments WHERE profile_id = ?1", params![id])?;
        tx.execute("DELETE FROM navigation_events WHERE profile_id = ?1", params![id])?;
        tx.execute("DELETE FROM page_states WHERE profile_id = ?1", params![id])?;
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

    /// EventRecorder's TAB_CREATED event (TRD §4, ContinuumManager). Carries
    /// no url/title of its own — a tab's first real NAVIGATION event covers
    /// that — but its presence in the append-only log is what lets a later
    /// phase's RestoreManager tell "this tab existed but never navigated"
    /// apart from "this tab never existed."
    pub fn add_tab_created_event(&self, profile_id: &str, tab_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO navigation_events (profile_id, tab_id, type, timestamp)
             VALUES (?1, ?2, 'TAB_CREATED', ?3)",
            params![profile_id, tab_id, now_unix()],
        )?;
        Ok(())
    }

    // --- Continuum: StateCollector checkpoints (page_states) ---

    /// A periodic PageState checkpoint (Backend Schema §4) — browser-owned
    /// fields only for now (scroll position, a running navigation_index);
    /// zoom is a fixed 1.0 and the best-effort page-owned columns stay NULL
    /// until a later phase captures them. Nothing reads this table yet —
    /// Phase 4's MomentManager is what consumes it — but writing it now is
    /// what the Implementation Plan's Phase 3/4 dependency note calls for:
    /// Moments can't be built against a state table that doesn't exist yet.
    #[allow(clippy::too_many_arguments)]
    pub fn add_page_state_checkpoint(
        &self,
        profile_id: &str,
        tab_id: &str,
        url: &str,
        title: &str,
        favicon_url: Option<&str>,
        scroll_x: f64,
        scroll_y: f64,
        navigation_index: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO page_states
                (profile_id, tab_id, url, title, favicon_url, scroll_x, scroll_y, navigation_index, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![profile_id, tab_id, url, title, favicon_url, scroll_x, scroll_y, navigation_index, now_unix()],
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

    // --- Moments: MomentManager (save/freeze) + RestoreManager's read side ---

    /// The one write path for both Save Moment (`source: "explicit_save"`,
    /// every open tab) and Freeze (`source: "freeze"`, a single tab) — App
    /// Flow doc §5/§6 treats them as the same capture, differing only in
    /// framing and in what the frontend does afterward (Freeze closes the
    /// tab; Save doesn't). Each tab gets an immediate (non-debounced)
    /// page_states checkpoint per the TRD's "explicit Moments bypass the
    /// debounce window" rule, linked from its moment_tabs row so
    /// RestoreManager can reapply the exact captured scroll position, plus
    /// a MOMENT_SAVED/MOMENT_FROZEN navigation_event cross-linked via
    /// moment_events.
    pub fn save_moment(
        &self,
        profile_id: &str,
        name: &str,
        source: &str,
        tabs: &[MomentTabInput],
    ) -> rusqlite::Result<Moment> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let moment_id = uuid::Uuid::new_v4().to_string();
        let now = now_unix();
        let event_type = if source == "freeze" { "MOMENT_FROZEN" } else { "MOMENT_SAVED" };

        tx.execute(
            "INSERT INTO moments (id, profile_id, name, source, tab_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![moment_id, profile_id, name, source, tabs.len() as i64, now],
        )?;

        let mut summaries = Vec::with_capacity(tabs.len());
        for (i, tab) in tabs.iter().enumerate() {
            tx.execute(
                "INSERT INTO page_states
                    (profile_id, tab_id, url, title, favicon_url, scroll_x, scroll_y, navigation_index, is_checkpoint, timestamp)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, ?8)",
                params![profile_id, tab.tab_id, tab.url, tab.title, tab.favicon_url, tab.scroll_x, tab.scroll_y, now],
            )?;
            let page_state_id = tx.last_insert_rowid();

            tx.execute(
                "INSERT INTO moment_tabs (moment_id, tab_order, url, title, favicon_url, page_state_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![moment_id, i as i64, tab.url, tab.title, tab.favicon_url, page_state_id],
            )?;

            tx.execute(
                "INSERT INTO navigation_events (profile_id, tab_id, type, url, title, timestamp)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![profile_id, tab.tab_id, event_type, tab.url, tab.title, now],
            )?;
            let nav_event_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO moment_events (moment_id, navigation_event_id) VALUES (?1, ?2)",
                params![moment_id, nav_event_id],
            )?;

            summaries.push(MomentTabSummary {
                url: tab.url.clone(),
                title: tab.title.clone(),
                favicon_url: tab.favicon_url.clone(),
            });
        }

        tx.commit()?;
        Ok(Moment {
            id: moment_id,
            name: name.to_string(),
            tab_count: tabs.len() as i64,
            created_at: now,
            updated_at: now,
            tabs: summaries,
        })
    }

    /// Newest-first, each with its captured tabs — enough for the homepage's
    /// "4 tabs" copy and a preview of what's inside without a second
    /// round-trip per Moment.
    pub fn list_moments(&self, profile_id: &str) -> rusqlite::Result<Vec<Moment>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, tab_count, created_at, updated_at FROM moments
             WHERE profile_id = ?1 ORDER BY updated_at DESC",
        )?;
        let rows = stmt
            .query_map(params![profile_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut moments = Vec::with_capacity(rows.len());
        for (id, name, tab_count, created_at, updated_at) in rows {
            let mut tab_stmt = conn.prepare(
                "SELECT url, title, favicon_url FROM moment_tabs WHERE moment_id = ?1 ORDER BY tab_order ASC",
            )?;
            let tabs = tab_stmt
                .query_map(params![id], |row| {
                    Ok(MomentTabSummary {
                        url: row.get(0)?,
                        title: row.get(1)?,
                        favicon_url: row.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            moments.push(Moment { id, name, tab_count, created_at, updated_at, tabs });
        }
        Ok(moments)
    }

    /// Full detail for RestoreManager — each tab's captured scroll
    /// position alongside its url/title, read via a LEFT JOIN so a tab with
    /// no linked page_state (shouldn't happen, but not fatal) still comes
    /// back with a sane 0,0 default instead of failing the whole restore.
    pub fn get_moment(&self, id: &str) -> rusqlite::Result<Option<MomentDetail>> {
        let conn = self.conn.lock().unwrap();
        let name: Option<String> = conn
            .query_row("SELECT name FROM moments WHERE id = ?1", params![id], |row| row.get(0))
            .optional()?;
        let Some(name) = name else { return Ok(None) };

        let mut stmt = conn.prepare(
            "SELECT mt.url, mt.title, mt.favicon_url, COALESCE(ps.scroll_x, 0), COALESCE(ps.scroll_y, 0)
             FROM moment_tabs mt LEFT JOIN page_states ps ON ps.id = mt.page_state_id
             WHERE mt.moment_id = ?1 ORDER BY mt.tab_order ASC",
        )?;
        let tabs = stmt
            .query_map(params![id], |row| {
                Ok(MomentTabDetail {
                    url: row.get(0)?,
                    title: row.get(1)?,
                    favicon_url: row.get(2)?,
                    scroll_x: row.get(3)?,
                    scroll_y: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        Ok(Some(MomentDetail { id: id.to_string(), name, tabs }))
    }

    /// Cascades to moment_tabs/moment_events; the page_states rows those
    /// moment_tabs pointed at are deliberately left behind, becoming
    /// eligible for the (not-yet-built) retention sweep once nothing
    /// references them — Backend Schema §6.
    pub fn delete_moment(&self, id: &str) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM moment_events WHERE moment_id = ?1", params![id])?;
        tx.execute("DELETE FROM moment_tabs WHERE moment_id = ?1", params![id])?;
        tx.execute("DELETE FROM moments WHERE id = ?1", params![id])?;
        tx.commit()
    }

    pub fn rename_moment(&self, id: &str, name: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE moments SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, now_unix(), id],
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
