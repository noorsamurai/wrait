//! Storage and credentials.
//!
//! SQLite is compiled into the binary (rusqlite's `bundled` feature), so the
//! relay carries its own database engine and the portable exe needs nothing
//! installed on the host machine.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use scrypt::{scrypt, Params};
use sha2::{Digest, Sha256};

use super::model::{initials_of, now_ms, Attachment, Message, OfficeInfo, OfficeMode, Task, User};

/// Matches the Node relay: N=2^14, r=8, p=1, 64-byte output.
const LOG_N: u8 = 14;
const R: u32 = 8;
const P: u32 = 1;
const KEY_LEN: usize = 64;

const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

pub type Db = Arc<Mutex<Connection>>;

pub fn open(path: Option<&Path>) -> rusqlite::Result<Db> {
    let conn = match path {
        Some(p) => {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            Connection::open(p)?
        }
        None => Connection::open_in_memory()?,
    };

    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "foreign_keys", "ON").ok();
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS users (
          id           TEXT PRIMARY KEY,
          username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
          display_name TEXT NOT NULL,
          pw_hash      TEXT NOT NULL,
          pw_salt      TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          last_seen    INTEGER
        );

        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS files (
          id          TEXT PRIMARY KEY,
          owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          to_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          size        INTEGER NOT NULL,
          mime        TEXT NOT NULL,
          chunk_count INTEGER NOT NULL,
          complete    INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS file_chunks (
          file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          idx     INTEGER NOT NULL,
          PRIMARY KEY (file_id, idx)
        );

        CREATE TABLE IF NOT EXISTS settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id                TEXT PRIMARY KEY,
          owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_by        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title             TEXT NOT NULL,
          notes             TEXT NOT NULL DEFAULT '',
          due_at            INTEGER,
          cleared_at        INTEGER,
          created_at        INTEGER NOT NULL,
          source_message_id TEXT
        );
        CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner_id, cleared_at, due_at);

        CREATE TABLE IF NOT EXISTS messages (
          id        TEXT PRIMARY KEY,
          client_id TEXT,
          from_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          to_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          body      TEXT NOT NULL,
          alert     INTEGER NOT NULL DEFAULT 0,
          file_id   TEXT REFERENCES files(id) ON DELETE SET NULL,
          sent_at   INTEGER NOT NULL,
          read_at   INTEGER
        );
        CREATE INDEX IF NOT EXISTS messages_pair ON messages(from_id, to_id, sent_at);
        CREATE INDEX IF NOT EXISTS messages_to   ON messages(to_id, sent_at);
        "#,
    )?;

    Ok(Arc::new(Mutex::new(conn)))
}

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

fn derive(password: &str, salt: &str) -> String {
    let params = Params::new(LOG_N, R, P, KEY_LEN).expect("valid scrypt params");
    let mut out = vec![0u8; KEY_LEN];
    // Only fails on a bad output length, which is a constant here.
    scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut out).expect("scrypt");
    hex::encode(out)
}

pub fn hash_password(password: &str) -> (String, String) {
    let salt = random_hex(16);
    let hash = derive(password, &salt);
    (hash, salt)
}

pub fn verify_password(password: &str, hash: &str, salt: &str) -> bool {
    let candidate = derive(password, salt);
    // Constant-time compare so a wrong password cannot be narrowed by timing.
    if candidate.len() != hash.len() {
        return false;
    }
    candidate
        .bytes()
        .zip(hash.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub fn username_valid(username: &str) -> bool {
    let len = username.chars().count();
    (3..=32).contains(&len)
        && username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        && username
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

#[derive(Clone)]
pub struct UserRow {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub pw_hash: String,
    pub pw_salt: String,
    pub last_seen: Option<i64>,
}

impl UserRow {
    fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            username: row.get("username")?,
            display_name: row.get("display_name")?,
            pw_hash: row.get("pw_hash")?,
            pw_salt: row.get("pw_salt")?,
            last_seen: row.get("last_seen")?,
        })
    }

    pub fn to_user(&self, presence: &'static str) -> User {
        User {
            id: self.id.clone(),
            username: self.username.clone(),
            display_name: self.display_name.clone(),
            initials: initials_of(&self.display_name),
            presence,
            last_seen: self.last_seen,
        }
    }
}

pub fn list_users(db: &Db) -> Vec<UserRow> {
    let conn = db.lock().unwrap();
    let mut stmt = match conn.prepare("SELECT * FROM users ORDER BY display_name COLLATE NOCASE") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], UserRow::from_row);
    rows.map(|r| r.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

pub fn find_by_username(db: &Db, username: &str) -> Option<UserRow> {
    let conn = db.lock().unwrap();
    conn.query_row(
        "SELECT * FROM users WHERE username = ? COLLATE NOCASE",
        params![username],
        UserRow::from_row,
    )
    .optional()
    .ok()
    .flatten()
}

pub fn find_by_id(db: &Db, id: &str) -> Option<UserRow> {
    let conn = db.lock().unwrap();
    conn.query_row("SELECT * FROM users WHERE id = ?", params![id], UserRow::from_row)
        .optional()
        .ok()
        .flatten()
}

pub fn user_exists(db: &Db, id: &str) -> bool {
    let conn = db.lock().unwrap();
    conn.query_row("SELECT 1 FROM users WHERE id = ?", params![id], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

pub enum CreateUser {
    Created(String),
    Taken,
}

pub fn create_user(db: &Db, username: &str, display_name: &str, password: &str) -> CreateUser {
    if find_by_username(db, username).is_some() {
        return CreateUser::Taken;
    }
    let (hash, salt) = hash_password(password);
    let id = uuid::Uuid::new_v4().to_string();
    let conn = db.lock().unwrap();
    match conn.execute(
        "INSERT INTO users (id, username, display_name, pw_hash, pw_salt, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, NULL)",
        params![id, username, display_name, hash, salt, now_ms()],
    ) {
        Ok(_) => CreateUser::Created(id),
        // A concurrent signup with the same name loses the UNIQUE race.
        Err(_) => CreateUser::Taken,
    }
}

pub fn touch_user(db: &Db, id: &str) {
    let conn = db.lock().unwrap();
    let _ = conn.execute(
        "UPDATE users SET last_seen = ? WHERE id = ?",
        params![now_ms(), id],
    );
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

pub fn create_session(db: &Db, user_id: &str) -> String {
    let token = random_hex(32);
    let now = now_ms();
    let conn = db.lock().unwrap();
    let _ = conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        params![hash_token(&token), user_id, now, now + SESSION_TTL_MS],
    );
    token
}

pub fn resolve_session(db: &Db, token: &str) -> Option<UserRow> {
    if token.is_empty() {
        return None;
    }
    let conn = db.lock().unwrap();
    conn.query_row(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > ?",
        params![hash_token(token), now_ms()],
        UserRow::from_row,
    )
    .optional()
    .ok()
    .flatten()
}

pub fn destroy_session(db: &Db, token: &str) {
    let conn = db.lock().unwrap();
    let _ = conn.execute(
        "DELETE FROM sessions WHERE token_hash = ?",
        params![hash_token(token)],
    );
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

const MESSAGE_COLUMNS: &str = "m.id, m.client_id, m.from_id, m.to_id, m.body, m.alert, m.sent_at,
     m.read_at, m.file_id, f.name AS file_name, f.size AS file_size, f.mime AS file_mime";

fn message_from_row(row: &rusqlite::Row) -> rusqlite::Result<Message> {
    let file_id: Option<String> = row.get("file_id")?;
    let attachment = match file_id {
        Some(id) => Some(Attachment {
            file_id: id,
            name: row.get("file_name").unwrap_or_default(),
            size: row.get("file_size").unwrap_or_default(),
            mime: row.get("file_mime").unwrap_or_default(),
        }),
        None => None,
    };
    Ok(Message {
        id: row.get("id")?,
        client_id: row.get("client_id")?,
        from: row.get("from_id")?,
        to: row.get("to_id")?,
        body: row.get("body")?,
        attachment,
        alert: row.get::<_, i64>("alert")? == 1,
        sent_at: row.get("sent_at")?,
        read_at: row.get("read_at")?,
    })
}

pub fn insert_message(
    db: &Db,
    client_id: Option<&str>,
    from: &str,
    to: &str,
    body: &str,
    alert: bool,
    file_id: Option<&str>,
) -> Option<Message> {
    let id = uuid::Uuid::new_v4().to_string();
    {
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO messages (id, client_id, from_id, to_id, body, alert, file_id, sent_at, read_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
            params![id, client_id, from, to, body, alert as i64, file_id, now_ms()],
        )
        .ok()?;
    }
    get_message(db, &id)
}

pub fn get_message(db: &Db, id: &str) -> Option<Message> {
    let conn = db.lock().unwrap();
    conn.query_row(
        &format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages m LEFT JOIN files f ON f.id = m.file_id WHERE m.id = ?"
        ),
        params![id],
        message_from_row,
    )
    .optional()
    .ok()
    .flatten()
}

/// Recent history across every conversation, oldest first. Capped so a client
/// that has been away for months still gets a small payload on connect.
pub fn recent_history(db: &Db, user_id: &str, limit: i64) -> Vec<Message> {
    let conn = db.lock().unwrap();
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS} FROM messages m LEFT JOIN files f ON f.id = m.file_id
          WHERE m.from_id = ? OR m.to_id = ? ORDER BY m.sent_at DESC LIMIT ?"
    );
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<Message> = stmt
        .query_map(params![user_id, user_id, limit], message_from_row)
        .map(|r| r.filter_map(Result::ok).collect())
        .unwrap_or_default();
    out.reverse();
    out
}

pub fn mark_read(db: &Db, user_id: &str, peer: &str, up_to: i64) {
    let conn = db.lock().unwrap();
    let _ = conn.execute(
        "UPDATE messages SET read_at = ?
          WHERE to_id = ? AND from_id = ? AND sent_at <= ? AND read_at IS NULL",
        params![now_ms(), user_id, peer, up_to],
    );
}

/* ------------------------------------------------------------------ */
/* Office settings                                                     */
/* ------------------------------------------------------------------ */

pub fn get_setting(db: &Db, key: &str) -> Option<String> {
    let conn = db.lock().unwrap();
    conn.query_row("SELECT value FROM settings WHERE key = ?", params![key], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

pub fn set_setting(db: &Db, key: &str, value: &str) {
    let conn = db.lock().unwrap();
    let _ = conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    );
}

/// Fixes the office's mode and name the first time it is created.
///
/// Only ever writes when the key is absent, so restarting a passworded office
/// cannot silently drop it to open.
pub fn init_office(db: &Db, mode: OfficeMode, name: &str) {
    if get_setting(db, "office_mode").is_none() {
        set_setting(db, "office_mode", mode.as_str());
    }
    if get_setting(db, "office_name").is_none() {
        set_setting(db, "office_name", name);
    }
}

pub fn office_info(db: &Db) -> OfficeInfo {
    OfficeInfo {
        name: get_setting(db, "office_name").unwrap_or_else(|| "Lokalen".into()),
        mode: OfficeMode::parse(&get_setting(db, "office_mode").unwrap_or_default()),
        version: 1,
    }
}

/// Creates a passwordless account for an open office.
pub fn create_guest(db: &Db, display_name: &str) -> Option<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let username = format!("gast-{}", &id[..8]);
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO users (id, username, display_name, pw_hash, pw_salt, created_at, last_seen)
         VALUES (?, ?, ?, '', '', ?, NULL)",
        params![id, username, display_name, now_ms()],
    )
    .ok()?;
    Some(id)
}

/// Case-insensitive lookup by the name people actually type.
pub fn find_by_display_name(db: &Db, display_name: &str) -> Option<UserRow> {
    let wanted = display_name.to_lowercase();
    list_users(db)
        .into_iter()
        .find(|row| row.display_name.to_lowercase() == wanted)
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

fn task_from_row(row: &rusqlite::Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get("id")?,
        owner: row.get("owner_id")?,
        created_by: row.get("created_by")?,
        title: row.get("title")?,
        notes: row.get("notes")?,
        due_at: row.get("due_at")?,
        cleared_at: row.get("cleared_at")?,
        created_at: row.get("created_at")?,
        source_message_id: row.get("source_message_id")?,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn insert_task(
    db: &Db,
    owner: &str,
    created_by: &str,
    title: &str,
    notes: &str,
    due_at: Option<i64>,
    source_message_id: Option<&str>,
) -> Option<Task> {
    let id = uuid::Uuid::new_v4().to_string();
    {
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO tasks (id, owner_id, created_by, title, notes, due_at, cleared_at, created_at, source_message_id)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
            params![id, owner, created_by, title, notes, due_at, now_ms(), source_message_id],
        )
        .ok()?;
    }
    get_task(db, &id)
}

pub fn get_task(db: &Db, id: &str) -> Option<Task> {
    let conn = db.lock().unwrap();
    conn.query_row("SELECT * FROM tasks WHERE id = ?", params![id], task_from_row)
        .optional()
        .ok()
        .flatten()
}

/// A person's own list, plus anything they sent to someone else - so a sender
/// can see whether their request was cleared.
pub fn tasks_for(db: &Db, user_id: &str, limit: i64) -> Vec<Task> {
    let conn = db.lock().unwrap();
    let mut stmt = match conn.prepare(
        "SELECT * FROM tasks WHERE owner_id = ? OR created_by = ? ORDER BY created_at DESC LIMIT ?",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map(params![user_id, user_id, limit], task_from_row)
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

pub fn set_task_cleared(db: &Db, id: &str, cleared: bool) {
    let conn = db.lock().unwrap();
    let _ = conn.execute(
        "UPDATE tasks SET cleared_at = ? WHERE id = ?",
        params![cleared.then(now_ms), id],
    );
}

pub fn edit_task(db: &Db, id: &str, title: Option<&str>, notes: Option<&str>, due_at: Option<Option<i64>>) {
    let conn = db.lock().unwrap();
    if let Some(title) = title {
        let _ = conn.execute("UPDATE tasks SET title = ? WHERE id = ?", params![title, id]);
    }
    if let Some(notes) = notes {
        let _ = conn.execute("UPDATE tasks SET notes = ? WHERE id = ?", params![notes, id]);
    }
    if let Some(due) = due_at {
        let _ = conn.execute("UPDATE tasks SET due_at = ? WHERE id = ?", params![due, id]);
    }
}

pub fn delete_task(db: &Db, id: &str) {
    let conn = db.lock().unwrap();
    let _ = conn.execute("DELETE FROM tasks WHERE id = ?", params![id]);
}
