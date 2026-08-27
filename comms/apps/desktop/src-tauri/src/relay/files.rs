//! Chunked file transfer.
//!
//! Each chunk is written at its own byte offset, so chunks may arrive in any
//! order, an interrupted upload resumes from what is already stored, and only
//! one chunk is ever held in memory regardless of how large the file is.

use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension};

use super::model::{chunk_count_for, now_ms, CHUNK_SIZE};
use super::store::Db;

#[derive(Clone)]
pub struct FileRow {
    pub id: String,
    pub owner_id: String,
    pub to_id: String,
    pub name: String,
    pub size: i64,
    pub mime: String,
    pub chunk_count: i64,
    pub complete: bool,
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<FileRow> {
    Ok(FileRow {
        id: r.get("id")?,
        owner_id: r.get("owner_id")?,
        to_id: r.get("to_id")?,
        name: r.get("name")?,
        size: r.get("size")?,
        mime: r.get("mime")?,
        chunk_count: r.get("chunk_count")?,
        complete: r.get::<_, i64>("complete")? == 1,
    })
}

/// File ids are server-generated UUIDs. Validating the shape keeps any
/// caller-supplied value from reaching the filesystem as a path segment.
fn blob_path(data_dir: &Path, file_id: &str) -> Option<PathBuf> {
    let valid = file_id.len() == 36
        && file_id
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-');
    valid.then(|| data_dir.join("blobs").join(file_id))
}

pub fn get(db: &Db, file_id: &str) -> Option<FileRow> {
    let conn = db.lock().unwrap();
    conn.query_row("SELECT * FROM files WHERE id = ?", params![file_id], row)
        .optional()
        .ok()
        .flatten()
}

pub fn received_chunks(db: &Db, file_id: &str) -> Vec<i64> {
    let conn = db.lock().unwrap();
    let mut stmt = match conn.prepare("SELECT idx FROM file_chunks WHERE file_id = ? ORDER BY idx") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map(params![file_id], |r| r.get(0))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

pub fn init_upload(
    db: &Db,
    data_dir: &Path,
    owner_id: &str,
    name: &str,
    size: i64,
    mime: &str,
    to: &str,
) -> Result<String, String> {
    let file_id = uuid::Uuid::new_v4().to_string();
    // The stored name is display-only; strip any directory component a client
    // might send, since the bytes live under the UUID.
    let safe_name: String = name
        .replace(['/', '\\'], "_")
        .chars()
        .take(255)
        .collect();

    {
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO files (id, owner_id, to_id, name, size, mime, chunk_count, complete, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
            params![
                file_id,
                owner_id,
                to,
                safe_name,
                size,
                mime.chars().take(128).collect::<String>(),
                chunk_count_for(size as u64) as i64,
                now_ms()
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    let path = blob_path(data_dir, &file_id).ok_or("invalid file id")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Create the blob up front so out-of-order chunks can be written by offset.
    std::fs::File::create(&path).map_err(|e| e.to_string())?;

    Ok(file_id)
}

pub struct ChunkResult {
    pub complete: bool,
    pub received: Vec<i64>,
}

pub fn write_chunk(
    db: &Db,
    data_dir: &Path,
    file: &FileRow,
    index: i64,
    bytes: &[u8],
) -> Result<ChunkResult, String> {
    if index < 0 || index >= file.chunk_count {
        return Err("Chunk index out of range.".into());
    }

    let offset = index as u64 * CHUNK_SIZE;
    let expected = if index == file.chunk_count - 1 {
        file.size as u64 - offset
    } else {
        CHUNK_SIZE
    };
    if bytes.len() as u64 != expected {
        return Err(format!(
            "Chunk {index} should be {expected} bytes, got {}.",
            bytes.len()
        ));
    }

    let path = blob_path(data_dir, &file.id).ok_or("invalid file id")?;
    let mut handle = std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    handle
        .seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    handle.write_all(bytes).map_err(|e| e.to_string())?;

    {
        let conn = db.lock().unwrap();
        let _ = conn.execute(
            "INSERT OR IGNORE INTO file_chunks (file_id, idx) VALUES (?, ?)",
            params![file.id, index],
        );
    }

    let received = received_chunks(db, &file.id);
    let complete = received.len() as i64 == file.chunk_count;
    if complete {
        let conn = db.lock().unwrap();
        let _ = conn.execute(
            "UPDATE files SET complete = 1 WHERE id = ?",
            params![file.id],
        );
    }

    Ok(ChunkResult { complete, received })
}

pub fn read_blob(data_dir: &Path, file: &FileRow) -> Result<Vec<u8>, String> {
    let path = blob_path(data_dir, &file.id).ok_or("invalid file id")?;
    std::fs::read(&path).map_err(|e| e.to_string())
}
