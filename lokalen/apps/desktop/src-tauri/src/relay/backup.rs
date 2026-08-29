//! Taking the office away with you, and putting it back.
//!
//! Everything the office is - accounts, rooms, every message, every
//! attachment - lives in one folder on one computer. That is fine right up
//! until the disk in that computer fails, at which point the whole clinic's
//! correspondence is gone. So there has to be a way to hold the lot in one
//! file that someone can copy onto a stick and take home.
//!
//! The file is itself a SQLite database: the office's own, copied cleanly,
//! with the attachments carried inside it. That means no archive format to
//! get wrong, no second library, and a backup that can be opened and read
//! years from now by anything that speaks SQL.

use std::path::Path;

use rusqlite::{params, Connection};
use serde::Serialize;

use super::store::Db;

/// Attachments are stored in pieces so that a single large file cannot run
/// into SQLite's limit on the size of one value.
const BLOB_PIECE: usize = 8 * 1024 * 1024;

const FORMAT: i64 = 1;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub messages: i64,
    pub files: i64,
    pub bytes: i64,
    /// Where the file ended up, or came from.
    pub path: String,
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0)
}

/// Writes the whole office to `target`.
pub fn export(db: &Db, data_dir: &Path, target: &Path) -> Result<Summary, String> {
    // VACUUM INTO refuses to overwrite, and the save dialog has already asked
    // about replacing the file.
    let _ = std::fs::remove_file(target);

    {
        let conn = db.lock().unwrap();
        // Inside a read transaction, so the copy is a point in time rather
        // than a file read out from under live writes.
        conn.execute("VACUUM INTO ?", params![target.to_string_lossy()])
            .map_err(|e| format!("Kunde inte kopiera databasen: {e}"))?;
    }

    let out = Connection::open(target).map_err(|e| e.to_string())?;
    out.execute_batch(
        "CREATE TABLE backup_meta (format INTEGER NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE backup_blobs (file_id TEXT NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL,
                                    PRIMARY KEY (file_id, idx));",
    )
    .map_err(|e| e.to_string())?;
    out.execute(
        "INSERT INTO backup_meta (format, created_at) VALUES (?, ?)",
        params![FORMAT, super::model::now_ms()],
    )
    .map_err(|e| e.to_string())?;

    let ids: Vec<String> = {
        let mut stmt = out
            .prepare("SELECT id FROM files WHERE complete = 1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };

    let mut summary = Summary {
        messages: count(&out, "SELECT COUNT(*) FROM messages"),
        path: target.to_string_lossy().to_string(),
        ..Summary::default()
    };

    for id in ids {
        let Some(path) = super::files::blob_path(data_dir, &id) else {
            continue;
        };
        // A row whose bytes have gone missing is worth stepping over rather
        // than failing the whole backup for.
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        for (idx, piece) in bytes.chunks(BLOB_PIECE).enumerate() {
            out.execute(
                "INSERT INTO backup_blobs (file_id, idx, bytes) VALUES (?, ?, ?)",
                params![id, idx as i64, piece],
            )
            .map_err(|e| e.to_string())?;
        }
        summary.files += 1;
        summary.bytes += bytes.len() as i64;
    }

    Ok(summary)
}

/// Replaces this machine's office with the one in `source`.
///
/// The caller is expected to have stopped hosting first: this swaps the file
/// the relay reads from.
pub fn import(db: &Db, data_dir: &Path, source: &Path) -> Result<Summary, String> {
    let db_path = data_dir.join("lokalen.db");
    let staged = db_path.with_extension("restoring");
    let _ = std::fs::remove_file(&staged);
    std::fs::copy(source, &staged).map_err(|e| format!("Kunde inte läsa säkerhetskopian: {e}"))?;

    let incoming = Connection::open(&staged).map_err(|e| e.to_string())?;
    let format: Option<i64> = incoming
        .query_row("SELECT format FROM backup_meta LIMIT 1", [], |r| r.get(0))
        .ok();
    if format != Some(FORMAT) {
        let _ = std::fs::remove_file(&staged);
        return Err("Filen är inte en säkerhetskopia av Lokalen.".into());
    }

    let mut summary = Summary {
        messages: count(&incoming, "SELECT COUNT(*) FROM messages"),
        path: source.to_string_lossy().to_string(),
        ..Summary::default()
    };

    // Attachments go back to disk before the database is swapped in, so a
    // restore that fails halfway leaves the running office untouched.
    let blobs = data_dir.join("blobs");
    std::fs::create_dir_all(&blobs).map_err(|e| e.to_string())?;
    let ids: Vec<String> = {
        let mut stmt = incoming
            .prepare("SELECT DISTINCT file_id FROM backup_blobs")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };
    for id in ids {
        let Some(path) = super::files::blob_path(data_dir, &id) else {
            continue;
        };
        let mut stmt = incoming
            .prepare("SELECT bytes FROM backup_blobs WHERE file_id = ? ORDER BY idx")
            .map_err(|e| e.to_string())?;
        let pieces = stmt
            .query_map(params![id], |r| r.get::<_, Vec<u8>>(0))
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        for piece in pieces.filter_map(Result::ok) {
            bytes.extend_from_slice(&piece);
        }
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        summary.files += 1;
        summary.bytes += bytes.len() as i64;
    }

    incoming
        .execute_batch("DROP TABLE backup_blobs; DROP TABLE backup_meta; VACUUM;")
        .map_err(|e| e.to_string())?;
    drop(incoming);

    {
        let mut conn = db.lock().unwrap();
        // The old connection has to let go of its write-ahead log before the
        // file underneath it is replaced.
        *conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        for suffix in ["-wal", "-shm"] {
            let mut side = db_path.clone().into_os_string();
            side.push(suffix);
            let _ = std::fs::remove_file(std::path::PathBuf::from(side));
        }
        std::fs::rename(&staged, &db_path).map_err(|e| e.to_string())?;
        *conn = super::store::open_connection(&db_path).map_err(|e| e.to_string())?;
    }

    Ok(summary)
}
