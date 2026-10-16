//! What the phone keeps beside its archive, in its own private folder: who
//! it is (the pairing), and the last copy of what it read of the things only
//! the computer has (the files and the container of a chat, the projects).
//!
//! A copy is what the interface shows at once, with the computer there or
//! away: a page opens from it and is brought up to date after. Each copy
//! keeps the tag the computer gave its answer, so that asking whether it is
//! still good costs a few bytes. It is refreshed by every read and let go of
//! when something is written to what it shows.
//!
//! The archive itself (chats, the assistant's pages, the settings) is not
//! here: it is the phone's own, in archive.rs.

use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
use std::sync::Mutex;

pub struct Store {
    db: Mutex<Connection>,
}

/// An answer of the archive as it was read.
#[derive(Clone, Debug)]
pub struct Kept {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
    /// The computer's tag of this answer; none for a copy changed here.
    pub tag: Option<String>,
}

// A copy larger than this is not kept: a video read once is read again.
const KEPT_MOST: usize = 4 * 1024 * 1024;

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let db = Connection::open(path)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS copies (
               key TEXT PRIMARY KEY, status INTEGER NOT NULL, content_type TEXT NOT NULL,
               body BLOB NOT NULL, read_at INTEGER NOT NULL
             );
             DROP TABLE IF EXISTS waiting;",
        )?;
        // Added after the first version: a copy made before it has no tag, and is read again.
        let _ = db.execute("ALTER TABLE copies ADD COLUMN tag TEXT", []);
        Ok(Store { db: Mutex::new(db) })
    }

    pub fn get(&self, key: &str) -> Option<String> {
        let db = self.db.lock().unwrap();
        db.query_row("SELECT value FROM kv WHERE key=?", [key], |row| row.get(0)).optional().ok().flatten()
    }

    pub fn set(&self, key: &str, value: Option<&str>) {
        let db = self.db.lock().unwrap();
        let _ = match value {
            Some(value) => db.execute("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value]),
            None => db.execute("DELETE FROM kv WHERE key=?", [key]),
        };
    }

    /* ---------------------------------------------------------------- */
    /* The copy                                                           */
    /* ---------------------------------------------------------------- */

    pub fn keep(&self, key: &str, kept: &Kept) {
        if kept.body.len() > KEPT_MOST {
            return;
        }
        let db = self.db.lock().unwrap();
        let _ = db.execute(
            "INSERT INTO copies(key, status, content_type, body, read_at, tag) VALUES(?, ?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET status=excluded.status, content_type=excluded.content_type, body=excluded.body, read_at=excluded.read_at, tag=excluded.tag",
            params![key, kept.status, kept.content_type, kept.body, now(), kept.tag],
        );
    }

    pub fn copy(&self, key: &str) -> Option<Kept> {
        let db = self.db.lock().unwrap();
        db.query_row("SELECT status, content_type, body, tag FROM copies WHERE key=?", [key], |row| {
            Ok(Kept { status: row.get(0)?, content_type: row.get(1)?, body: row.get(2)?, tag: row.get(3)? })
        })
        .optional()
        .ok()
        .flatten()
    }

    /// The JSON copies and their tags, the most recently read first: what a snapshot asks about.
    pub fn tags(&self, most: usize) -> Vec<(String, Option<String>)> {
        let db = self.db.lock().unwrap();
        let Ok(mut query) = db.prepare("SELECT key, tag FROM copies WHERE content_type LIKE 'application/json%' ORDER BY read_at DESC LIMIT ?") else { return Vec::new() };
        query.query_map([most as i64], |row| Ok((row.get(0)?, row.get(1)?))).map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    pub fn forget(&self, key: &str) {
        let db = self.db.lock().unwrap();
        let _ = db.execute("DELETE FROM copies WHERE key=?", [key]);
    }

    /// The copies that a change to `path` makes old: the thing itself, what is
    /// under it, and the lists it is part of.
    pub fn forget_under(&self, path: &str) {
        let path = path.split('?').next().unwrap_or(path).trim_end_matches('/');
        let mut prefixes = vec![path.to_string()];
        let mut parent = path;
        while let Some(at) = parent.rfind('/') {
            parent = &parent[..at];
            if parent == "/api" || parent.is_empty() {
                break;
            }
            prefixes.push(parent.to_string());
        }
        let db = self.db.lock().unwrap();
        // The thing and everything under it.
        let _ = db.execute("DELETE FROM copies WHERE key = ?1 OR key LIKE ?2 ESCAPE '\\' OR key LIKE ?3 ESCAPE '\\'", params![path, format!("{}/%", like(path)), format!("{}?%", like(path))]);
        // The lists above it, read whole or filtered.
        for prefix in prefixes.iter().skip(1) {
            let _ = db.execute("DELETE FROM copies WHERE key = ?1 OR key LIKE ?2 ESCAPE '\\'", params![prefix, format!("{}?%", like(prefix))]);
        }
    }

    pub fn forget_copies(&self) {
        let db = self.db.lock().unwrap();
        let _ = db.execute("DELETE FROM copies", []);
    }

    /// Everything of the computer the phone was paired with: the phone is unpaired.
    pub fn forget_all(&self) {
        let db = self.db.lock().unwrap();
        let _ = db.execute_batch("DELETE FROM copies; DELETE FROM kv;");
    }
}

fn like(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("synthorg-phone-test-{}", uuid::Uuid::new_v4()));
        Store::open(&dir.join("phone.sqlite")).unwrap()
    }

    #[test]
    fn copies_keep_the_tag_the_computer_gave() {
        let s = store();
        s.keep("/api/settings", &Kept { tag: Some("abc".into()), ..kept("{}") });
        s.keep("/api/projects", &kept("[]"));
        s.keep("/api/conversations/a/files/x.png", &Kept { content_type: "image/png".into(), ..kept("png") });
        assert_eq!(s.copy("/api/settings").unwrap().tag.as_deref(), Some("abc"));
        let mut tags = s.tags(10);
        tags.sort();
        assert_eq!(tags, vec![("/api/projects".to_string(), None), ("/api/settings".to_string(), Some("abc".to_string()))], "the JSON copies, not the bytes");
        s.forget("/api/projects");
        assert!(s.copy("/api/projects").is_none());
    }

    fn kept(text: &str) -> Kept {
        Kept { status: 200, content_type: "application/json".into(), body: text.as_bytes().to_vec(), tag: None }
    }

    #[test]
    fn a_change_lets_go_of_the_thing_what_is_under_it_and_its_lists() {
        let s = store();
        for key in ["/api/conversations", "/api/conversations?q=&archived=false", "/api/conversations/a", "/api/conversations/a/messages?after=0", "/api/conversations/b", "/api/settings/x", "/api/conversations/ab"] {
            s.keep(key, &kept(key));
        }
        s.forget_under("/api/conversations/a/messages");
        assert!(s.copy("/api/conversations").is_none());
        assert!(s.copy("/api/conversations?q=&archived=false").is_none());
        assert!(s.copy("/api/conversations/a").is_none());
        assert!(s.copy("/api/conversations/a/messages?after=0").is_none());
        assert!(s.copy("/api/conversations/b").is_some());
        assert!(s.copy("/api/conversations/ab").is_some());
        assert!(s.copy("/api/settings/x").is_some());
    }
}
