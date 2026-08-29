//! Keeping a standby machine's copy of the office up to date.
//!
//! A standby serves nothing. It dials the machine that is hosting, takes a
//! copy of the database if it has none, then follows the office's log so that
//! its own copy stays a few hundred milliseconds behind the host's. That is
//! the whole point: when the hosting computer is switched off at the end of a
//! shift, another one can start serving from a database that already has
//! everything in it.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::Connection;
use serde::Deserialize;

use super::files;
use super::oplog::{self, Entry};
use super::store::Db;

/// Long-poll window. The host holds the request open until something happens,
/// so replication is prompt without anyone polling in a tight loop.
const WAIT_MS: u64 = 20_000;

/// Reported when the host's log and this machine's no longer join up.
pub const GAP: &str = "hål i loggen";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub office: String,
    pub term: i64,
    pub seq: i64,
}

#[derive(Debug, Deserialize)]
struct OpsPage {
    term: i64,
    entries: Vec<Entry>,
    /// Set when the host's history no longer contains ours.
    #[serde(default)]
    reset: bool,
}

pub struct Replica {
    client: reqwest::Client,
    host: String,
    token: String,
    db: Db,
    db_path: PathBuf,
    data_dir: PathBuf,
}

impl Replica {
    pub fn new(host: &str, token: &str, db: Db, data_dir: &Path) -> Self {
        Self {
            client: reqwest::Client::builder()
                // A host that has gone away must fail quickly, or a standby
                // waits on a dead socket instead of standing for election.
                .connect_timeout(Duration::from_secs(4))
                .build()
                .unwrap_or_default(),
            host: host.trim_end_matches('/').to_string(),
            token: token.to_string(),
            db,
            db_path: data_dir.join("lokalen.db"),
            data_dir: data_dir.to_path_buf(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.host)
    }

    pub async fn info(&self) -> Result<HostInfo, String> {
        let response = self
            .client
            .get(self.url("/api/replica/info"))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("värden svarade {}", response.status().as_u16()));
        }
        response.json::<HostInfo>().await.map_err(|e| e.to_string())
    }

    /// Replaces this machine's copy with the host's.
    ///
    /// Used when a machine joins an office it has never seen, and when it
    /// finds that the office has moved on under a newer term - in which case
    /// anything it wrote while it was cut off is discarded rather than merged.
    /// A machine that was unreachable was not taking anyone's messages, so
    /// there is nothing there worth the risk of a half-merged history.
    pub async fn take_snapshot(&self) -> Result<i64, String> {
        let response = self
            .client
            .get(self.url("/api/replica/snapshot"))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("värden svarade {}", response.status().as_u16()));
        }
        let seq: i64 = response
            .headers()
            .get("x-lokalen-seq")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        // Written beside the live database and moved into place, so an
        // interrupted download cannot leave the machine with half an office.
        let staged = self.db_path.with_extension("incoming");
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        tokio::fs::write(&staged, &bytes)
            .await
            .map_err(|e| e.to_string())?;

        {
            let mut conn = self.db.lock().unwrap();
            // Dropping the old connection first: the write-ahead log beside it
            // belongs to the file being replaced.
            *conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
            for suffix in ["-wal", "-shm"] {
                let mut side = self.db_path.clone().into_os_string();
                side.push(suffix);
                let _ = std::fs::remove_file(PathBuf::from(side));
            }
            std::fs::rename(&staged, &self.db_path).map_err(|e| e.to_string())?;
            *conn = super::store::open_connection(&self.db_path).map_err(|e| e.to_string())?;
        }

        Ok(seq)
    }

    pub fn watermark(&self) -> i64 {
        oplog::watermark(&self.db.lock().unwrap())
    }

    /// One turn of following the host: waits for entries, applies them, and
    /// reports the host's term so the caller can notice it has been overtaken.
    pub async fn follow_once(&self) -> Result<i64, String> {
        self.follow(WAIT_MS).await
    }

    /// The same, with the host holding the request open for `wait` at most.
    /// Zero returns whatever is already there, which is what a caller wanting
    /// to catch up rather than wait for the next message asks for.
    pub async fn follow(&self, wait: u64) -> Result<i64, String> {
        let since = self.watermark();
        let response = self
            .client
            .get(self.url("/api/replica/ops"))
            .query(&[("since", since.to_string()), ("wait", wait.to_string())])
            .bearer_auth(&self.token)
            .timeout(Duration::from_millis(wait + 10_000))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("värden svarade {}", response.status().as_u16()));
        }
        let page: OpsPage = response.json().await.map_err(|e| e.to_string())?;

        // A gap means the host's log no longer joins onto ours: it starts
        // after ours ends, or it has been replaced from a backup and is a
        // different story altogether. Only a fresh copy can settle it.
        if page.reset {
            return Err(GAP.into());
        }
        if let Some(first) = page.entries.first() {
            if first.seq > since + 1 {
                return Err(GAP.into());
            }
        }

        let applied = {
            let conn = self.db.lock().unwrap();
            let mut applied = Vec::new();
            for entry in &page.entries {
                match oplog::apply(&conn, entry) {
                    Ok(()) => applied.push(entry.clone()),
                    Err(err) => {
                        eprintln!("[replica] hoppade över {}: {err}", entry.kind);
                    }
                }
            }
            applied
        };

        // Attachments are not in the log - only the fact that one exists - so
        // the bytes are fetched as their rows arrive. Without this a machine
        // that took over would show every picture as a broken file.
        for entry in applied.iter().filter(|e| e.kind == "file.complete") {
            if let Some(id) = first_arg(&entry.args) {
                if let Err(err) = self.fetch_blob(&id).await {
                    eprintln!("[replica] kunde inte hämta bilagan {id}: {err}");
                }
            }
        }

        Ok(page.term)
    }

    /// Downloads one attachment, unless this machine already has it.
    pub async fn fetch_blob(&self, file_id: &str) -> Result<(), String> {
        let Some(path) = files::blob_path(&self.data_dir, file_id) else {
            return Err("ogiltigt fil-id".into());
        };
        if path.exists() {
            return Ok(());
        }
        let response = self
            .client
            .get(self.url(&format!("/api/replica/blob/{file_id}")))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("värden svarade {}", response.status().as_u16()));
        }
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        if let Some(dir) = path.parent() {
            let _ = tokio::fs::create_dir_all(dir).await;
        }
        let staged = path.with_extension("part");
        tokio::fs::write(&staged, &bytes)
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::rename(&staged, &path)
            .await
            .map_err(|e| e.to_string())
    }

    /// Fetches any attachment this machine is still missing.
    ///
    /// Catches what the live tail could not: files that were already complete
    /// when the snapshot was taken, and any download that failed at the time.
    pub async fn backfill_blobs(&self, limit: usize) -> usize {
        let wanted: Vec<String> = {
            let conn = self.db.lock().unwrap();
            let mut stmt = match conn
                .prepare("SELECT id FROM files WHERE complete = 1 ORDER BY created_at DESC LIMIT ?")
            {
                Ok(stmt) => stmt,
                Err(_) => return 0,
            };
            let rows = stmt.query_map([limit as i64], |r| r.get::<_, String>(0));
            match rows {
                Ok(rows) => rows.filter_map(Result::ok).collect(),
                Err(_) => return 0,
            }
        };

        let mut fetched = 0;
        for id in wanted {
            let missing = files::blob_path(&self.data_dir, &id)
                .map(|p| !p.exists())
                .unwrap_or(false);
            if missing && self.fetch_blob(&id).await.is_ok() {
                fetched += 1;
            }
        }
        fetched
    }
}

/// The first bound value of a logged statement, when it is a string.
fn first_arg(args: &str) -> Option<String> {
    serde_json::from_str::<Vec<serde_json::Value>>(args)
        .ok()?
        .into_iter()
        .next()?
        .as_str()
        .map(str::to_string)
}
