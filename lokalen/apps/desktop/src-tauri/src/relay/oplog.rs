//! The office's replication log.
//!
//! Every machine in the office keeps a complete copy of it, so that when the
//! computer currently hosting is switched off, another one can take over with
//! the whole history rather than an empty database.
//!
//! Replication is statement-based: each write is appended here as the name of
//! a statement plus the values that were bound to it, and a standby replays
//! them. That is only sound because nothing in a replicated statement is
//! computed by SQLite - every id, hash and timestamp is produced in Rust and
//! passed as a parameter - so replaying one on another machine cannot
//! diverge from where it ran first.
//!
//! Only the *name* travels, never the SQL. A standby looks the statement up in
//! its own binary, so a machine that has been talked into replicating from
//! somewhere untrustworthy still cannot be made to run arbitrary SQL.

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};

use super::model::now_ms;

/// One replicated statement, named so that only known SQL can ever run.
pub struct Op {
    pub kind: &'static str,
    pub sql: &'static str,
}

macro_rules! ops {
    ($($name:ident => $kind:literal, $sql:literal;)+) => {
        $(pub const $name: Op = Op { kind: $kind, sql: $sql };)+
        const ALL: &[&Op] = &[$(&$name),+];
    };
}

ops! {
    USER_CREATE => "user.create",
        "INSERT INTO users (id, username, display_name, pw_hash, pw_salt, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, NULL)";
    USER_GUEST => "user.guest",
        "INSERT INTO users (id, username, display_name, pw_hash, pw_salt, created_at, last_seen)
         VALUES (?, ?, ?, '', '', ?, NULL)";
    ROOM_CREATE => "room.create",
        "INSERT INTO users (id, username, display_name, pw_hash, pw_salt, created_at, last_seen, kind)
         VALUES (?, ?, ?, '', '', ?, NULL, ?)";
    USER_TOUCH => "user.touch",
        "UPDATE users SET last_seen = ? WHERE id = ?";
    USER_AVAILABILITY => "user.availability",
        "UPDATE users SET availability = ? WHERE id = ?";
    USER_OPERATOR => "user.operator",
        "UPDATE users SET operator = ? WHERE id = ?";

    SESSION_CREATE => "session.create",
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)";
    SESSION_DESTROY => "session.destroy",
        "DELETE FROM sessions WHERE token_hash = ?";

    MESSAGE_INSERT => "message.insert",
        "INSERT INTO messages (id, client_id, from_id, to_id, body, body_plain, alert, file_id, sent_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)";
    MESSAGE_READ => "message.read",
        "UPDATE messages SET read_at = ?
          WHERE to_id = ? AND from_id = ? AND sent_at <= ? AND read_at IS NULL";
    MESSAGE_EDIT => "message.edit",
        "UPDATE messages SET body = ?, body_plain = ?, edited_at = ? WHERE id = ?";
    MESSAGE_DELETE => "message.delete",
        "UPDATE messages SET body = '', body_plain = '', file_id = NULL, deleted_at = ? WHERE id = ?";
    REVISION_INSERT => "revision.insert",
        "INSERT INTO message_revisions (message_id, body, replaced_at) VALUES (?, ?, ?)";
    REVISION_CLEAR => "revision.clear",
        "DELETE FROM message_revisions WHERE message_id = ?";

    TASK_INSERT => "task.insert",
        "INSERT INTO tasks (id, owner_id, created_by, title, notes, due_at, cleared_at, created_at, source_message_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)";
    TASK_CLEARED => "task.cleared", "UPDATE tasks SET cleared_at = ? WHERE id = ?";
    TASK_TITLE   => "task.title",   "UPDATE tasks SET title = ? WHERE id = ?";
    TASK_NOTES   => "task.notes",   "UPDATE tasks SET notes = ? WHERE id = ?";
    TASK_DUE     => "task.due",     "UPDATE tasks SET due_at = ? WHERE id = ?";
    TASK_DELETE  => "task.delete",  "DELETE FROM tasks WHERE id = ?";

    SETTING_SET => "setting.set",
        "INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value";

    FILE_INSERT => "file.insert",
        "INSERT INTO files (id, owner_id, to_id, name, size, mime, chunk_count, complete, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)";
    FILE_COMPLETE => "file.complete",
        "UPDATE files SET complete = 1 WHERE id = ?";
}

fn sql_for(kind: &str) -> Option<&'static str> {
    ALL.iter().find(|op| op.kind == kind).map(|op| op.sql)
}

/// Builds the bound values for a replicated statement.
///
/// Everything goes through JSON so the same values can be written to the log
/// and handed to SQLite without a second spelling of each call site.
#[macro_export]
macro_rules! args {
    ($($value:expr),* $(,)?) => {
        vec![$(serde_json::json!($value)),*]
    };
}

fn bind(value: &serde_json::Value) -> Value {
    match value {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Integer(i64::from(*b)),
        serde_json::Value::Number(n) => n
            .as_i64()
            .map(Value::Integer)
            .or_else(|| n.as_f64().map(Value::Real))
            .unwrap_or(Value::Null),
        serde_json::Value::String(s) => Value::Text(s.clone()),
        // Nothing replicated is an array or an object; storing the JSON keeps
        // a future caller's mistake visible rather than silently null.
        other => Value::Text(other.to_string()),
    }
}

/// One entry, as it travels to a standby.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub seq: i64,
    pub at: i64,
    pub kind: String,
    /// JSON array of the values bound to the statement.
    pub args: String,
}

/// Runs a write and records it for the other machines, in one transaction.
///
/// A caller that does not care whether the row landed can ignore the result,
/// exactly as it could with `Connection::execute`.
pub fn write(conn: &Connection, op: &Op, values: Vec<serde_json::Value>) -> rusqlite::Result<usize> {
    let tx = conn.unchecked_transaction()?;
    let affected = tx.execute(op.sql, params_from_iter(values.iter().map(bind)))?;
    tx.execute(
        "INSERT INTO oplog (at, kind, args) VALUES (?, ?, ?)",
        params![
            now_ms(),
            op.kind,
            serde_json::to_string(&values).unwrap_or_else(|_| "[]".into())
        ],
    )?;
    tx.commit()?;
    Ok(affected)
}

/// Applies an entry received from the host, keeping its sequence number.
///
/// The sequence is shared across the office, so a standby that later takes
/// over continues the same log rather than starting a second one.
pub fn apply(conn: &Connection, entry: &Entry) -> Result<(), String> {
    let sql = sql_for(&entry.kind).ok_or_else(|| format!("okänd åtgärd {}", entry.kind))?;
    let values: Vec<serde_json::Value> =
        serde_json::from_str(&entry.args).map_err(|e| e.to_string())?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // A replayed insert can collide with a row the snapshot already carried;
    // that is convergence, not a failure, so only the log entry is required
    // to land.
    let _ = tx.execute(sql, params_from_iter(values.iter().map(bind)));
    tx.execute(
        "INSERT OR REPLACE INTO oplog (seq, at, kind, args) VALUES (?, ?, ?, ?)",
        params![entry.seq, entry.at, entry.kind, entry.args],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// How much of the log this machine holds. The basis for deciding which
/// standby is the most complete, and so which one should take over.
pub fn watermark(conn: &Connection) -> i64 {
    conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM oplog", [], |r| r.get(0))
        .unwrap_or(0)
}

/// Entries after `since`, oldest first.
pub fn since(conn: &Connection, since: i64, limit: i64) -> Vec<Entry> {
    let mut stmt = match conn
        .prepare("SELECT seq, at, kind, args FROM oplog WHERE seq > ? ORDER BY seq LIMIT ?")
    {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    stmt.query_map(params![since, limit], |row| {
        Ok(Entry {
            seq: row.get(0)?,
            at: row.get(1)?,
            kind: row.get(2)?,
            args: row.get(3)?,
        })
    })
    .map(|rows| rows.filter_map(Result::ok).collect())
    .unwrap_or_default()
}
