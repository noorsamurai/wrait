//! Which computer is hosting the office, and what happens when it stops.
//!
//! An office is one relay and several clients. That is fine until the machine
//! running the relay is switched off at the end of a shift, at which point
//! everyone else is looking at a dead window even though they are all still
//! sitting at their desks on the same network.
//!
//! So every machine keeps a full copy of the office (see `replica`), and the
//! ones that are not hosting stand by. When the host goes quiet they agree
//! among themselves - by how much of the history each of them holds - which
//! one starts serving, and everyone reconnects to it. The people in the rooms
//! see a few seconds of "återansluter" and then carry on.
//!
//! What this deliberately does not do is merge. A machine that was cut off
//! and hosted its own island of an office does not get to graft that island
//! back on when it returns: it discards it and takes a fresh copy. A machine
//! nobody could reach was not taking anybody's messages, so there is nothing
//! there worth the risk of a history that never quite agrees with itself.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::discovery::{self, Candidate, Election};
use super::model::OfficeMode;
use super::replica::Replica;
use super::store::{self, Db};
use super::{Relay, RelayInfo};

/// What this machine is doing about the office right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// No office on this machine yet.
    Idle,
    /// Serving the office.
    Host,
    /// Following the host, ready to take over.
    Standby,
    /// Following nobody: the host is unreachable and an election is running.
    Seeking,
}

/// What survives a restart. Deliberately not in the office database, which is
/// replaced wholesale whenever this machine takes a fresh copy.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Saved {
    instance: String,
    office: String,
    term: i64,
    /// The last address this machine used, so it can try that first rather
    /// than waiting for a beacon on a network that drops multicast.
    #[serde(default)]
    host: String,
    #[serde(default)]
    token: String,
}

fn saved_path(data_dir: &Path) -> PathBuf {
    data_dir.join("cluster.json")
}

fn load(data_dir: &Path) -> Saved {
    let mut saved: Saved = std::fs::read_to_string(saved_path(data_dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if saved.instance.is_empty() {
        saved.instance = uuid::Uuid::new_v4().to_string();
    }
    saved
}

fn save(data_dir: &Path, saved: &Saved) {
    if let Ok(raw) = serde_json::to_string_pretty(saved) {
        let _ = std::fs::write(saved_path(data_dir), raw);
    }
}

/// Told to the app whenever the office moves, so the window can reconnect
/// rather than sitting on a socket to a machine that is off.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub role: Role,
    /// Where the office is being served right now, if anywhere.
    pub host: String,
    /// True when that is this very machine.
    pub hosting: bool,
    pub office: String,
    pub term: i64,
    /// How much of the office's history this machine holds.
    pub watermark: i64,
}

struct Inner {
    role: Role,
    host: String,
    relay: Option<Relay>,
}

pub struct Node {
    data_dir: PathBuf,
    db: Db,
    saved: Mutex<Saved>,
    inner: Mutex<Inner>,
    term: AtomicI64,
    /// Bumped whenever the supervisor should stop what it is doing and look
    /// again - a join, a handover, a shutdown.
    wake: tokio::sync::Notify,
    port: u16,
    office_name: String,
    mode: OfficeMode,
}

impl Node {
    pub fn open(data_dir: &Path, port: u16, office_name: &str, mode: OfficeMode) -> Arc<Self> {
        let saved = load(data_dir);
        let db = store::open(Some(&data_dir.join("lokalen.db")))
            .unwrap_or_else(|e| panic!("kunde inte öppna kontorets databas: {e}"));
        Arc::new(Self {
            data_dir: data_dir.to_path_buf(),
            db,
            term: AtomicI64::new(saved.term),
            saved: Mutex::new(saved),
            inner: Mutex::new(Inner {
                role: Role::Idle,
                host: String::new(),
                relay: None,
            }),
            wake: tokio::sync::Notify::new(),
            port,
            office_name: office_name.to_string(),
            mode,
        })
    }

    pub fn status(&self) -> Status {
        let inner = self.inner.lock().unwrap();
        let saved = self.saved.lock().unwrap();
        Status {
            role: inner.role,
            host: inner.host.clone(),
            hosting: inner.role == Role::Host,
            office: saved.office.clone(),
            term: self.term.load(Ordering::Relaxed),
            watermark: super::oplog::watermark(&self.db.lock().unwrap()),
        }
    }

    pub fn relay_info(&self) -> Option<RelayInfo> {
        self.inner.lock().unwrap().relay.as_ref().map(|r| r.info.clone())
    }

    /// Starts serving the office on this machine, creating it if this is the
    /// first time anyone has.
    pub async fn host(self: &Arc<Self>) -> Result<RelayInfo, String> {
        if let Some(info) = self.relay_info() {
            return Ok(info);
        }
        let term = self.term.load(Ordering::Relaxed).max(1);
        self.promote(term).await
    }

    /// Follows an office that another machine is already hosting.
    ///
    /// Called once the person has signed in there, because replication needs
    /// their session to prove this machine belongs in the office at all.
    pub async fn join(self: &Arc<Self>, host: &str, token: &str) -> Result<(), String> {
        let replica = Replica::new(host, token, self.db.clone(), &self.data_dir);
        let info = replica.info().await?;

        {
            let mut saved = self.saved.lock().unwrap();
            let changed_office = !saved.office.is_empty() && saved.office != info.office;
            saved.office = info.office.clone();
            saved.host = host.to_string();
            saved.token = token.to_string();
            if changed_office {
                // A different office entirely: nothing local is worth keeping.
                saved.term = 0;
            }
            save(&self.data_dir, &saved);
        }

        self.stop_hosting().await;
        {
            let mut inner = self.inner.lock().unwrap();
            inner.role = Role::Standby;
            inner.host = host.to_string();
        }
        self.wake.notify_waiters();
        Ok(())
    }

    /// Stops serving on request, and stops taking part in elections.
    ///
    /// Somebody who deliberately stops hosting does not want the machine
    /// quietly starting again a moment later because nobody else picked it up.
    pub async fn stand_down(self: &Arc<Self>) {
        self.stop_hosting().await;
        let mut inner = self.inner.lock().unwrap();
        inner.role = Role::Idle;
        inner.host.clear();
    }

    async fn stop_hosting(&self) {
        let relay = self.inner.lock().unwrap().relay.take();
        if let Some(relay) = relay {
            relay.stop().await;
        }
    }

    /// Binds the port and starts announcing, on the copy this machine already
    /// holds.
    async fn promote(self: &Arc<Self>, term: i64) -> Result<RelayInfo, String> {
        self.stop_hosting().await;
        let relay = super::start_with(
            self.db.clone(),
            self.port,
            &self.data_dir,
            self.mode,
            &self.office_name,
            term,
        )
        .await?;
        let info = relay.info.clone();
        let local = format!("http://127.0.0.1:{}", info.port);

        self.term.store(term, Ordering::Relaxed);
        {
            let mut saved = self.saved.lock().unwrap();
            saved.term = term;
            saved.office = store::office_id(&self.db);
            saved.host = local.clone();
            save(&self.data_dir, &saved);
        }
        {
            let mut inner = self.inner.lock().unwrap();
            inner.role = Role::Host;
            inner.host = local;
            inner.relay = Some(relay);
        }
        self.wake.notify_waiters();
        Ok(info)
    }

    /// Writes the whole office to one file.
    pub fn export(&self, target: &Path) -> Result<super::backup::Summary, String> {
        super::backup::export(&self.db, &self.data_dir, target)
    }

    /// Replaces this office with the one in a backup file.
    ///
    /// The machine starts hosting the restored office in a new round, so the
    /// other machines follow it here rather than carrying on with the history
    /// it just replaced.
    pub async fn restore(self: &Arc<Self>, source: &Path) -> Result<super::backup::Summary, String> {
        let was_hosting = self.inner.lock().unwrap().role == Role::Host;
        self.stop_hosting().await;
        let summary = super::backup::import(&self.db, &self.data_dir, source)?;

        let term = self.term.load(Ordering::Relaxed) + 1;
        {
            let mut saved = self.saved.lock().unwrap();
            saved.office = store::office_id(&self.db);
            saved.term = term;
            save(&self.data_dir, &saved);
        }
        self.term.store(term, Ordering::Relaxed);

        if was_hosting {
            self.promote(term).await?;
        }
        Ok(summary)
    }

    fn candidate(&self) -> Candidate {
        let saved = self.saved.lock().unwrap();
        Candidate {
            term: self.term.load(Ordering::Relaxed) + 1,
            watermark: super::oplog::watermark(&self.db.lock().unwrap()),
            instance: saved.instance.clone(),
        }
    }

    fn office(&self) -> String {
        self.saved.lock().unwrap().office.clone()
    }

    fn token(&self) -> String {
        self.saved.lock().unwrap().token.clone()
    }

    fn set_host(&self, url: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.role = Role::Standby;
        inner.host = url.to_string();
        let mut saved = self.saved.lock().unwrap();
        saved.host = url.to_string();
        save(&self.data_dir, &saved);
    }
}

/// Runs the machine's part in the office for as long as the app is open.
///
/// `on_change` is called whenever the office moves, so the window can point
/// itself at wherever it is being served now.
pub fn supervise(node: Arc<Node>, on_change: impl Fn(Status) + Send + 'static) {
    tokio::spawn(async move {
        let mut last = node.status();
        loop {
            let role = node.inner.lock().unwrap().role;
            match role {
                // Nothing to supervise until somebody hosts or joins.
                Role::Idle => node.wake.notified().await,
                Role::Host => watch_for_a_newer_host(&node).await,
                Role::Standby | Role::Seeking => follow_or_take_over(&node).await,
            }

            let now = node.status();
            if now.host != last.host || now.role != last.role || now.term != last.term {
                on_change(now.clone());
                last = now;
            }
        }
    });
}

/// A host steps down the moment it hears a later round of hosting for its own
/// office. Two hosts serving one office is the one outcome worse than none.
async fn watch_for_a_newer_host(node: &Arc<Node>) {
    let office = node.office();
    if office.is_empty() {
        tokio::time::sleep(Duration::from_secs(5)).await;
        return;
    }
    if let Some(found) = discovery::await_host(&office, Duration::from_secs(5)).await {
        let mine = node.term.load(Ordering::Relaxed);
        if found.term > mine {
            eprintln!("[kluster] {} är värd i omgång {} - avgår", found.url, found.term);
            node.stop_hosting().await;
            node.term.store(found.term, Ordering::Relaxed);
            {
                let mut saved = node.saved.lock().unwrap();
                saved.term = found.term;
                save(&node.data_dir, &saved);
            }
            node.set_host(&found.url);
        }
    }
}

/// Follows the host; if there is none, offers to become it.
async fn follow_or_take_over(node: &Arc<Node>) {
    let office = node.office();
    let token = node.token();
    let host = node.inner.lock().unwrap().host.clone();

    if !host.is_empty() && !token.is_empty() {
        let replica = Replica::new(&host, &token, node.db.clone(), &node.data_dir);
        match replica.info().await {
            Ok(info) if info.office == office => {
                node.term.store(info.term.max(node.term.load(Ordering::Relaxed)), Ordering::Relaxed);
                {
                    let mut inner = node.inner.lock().unwrap();
                    inner.role = Role::Standby;
                }
                // A machine with nothing, or one whose log no longer meets the
                // host's, starts again from a copy rather than a guess.
                if replica.watermark() == 0 {
                    if let Err(err) = replica.take_snapshot().await {
                        eprintln!("[kluster] kunde inte hämta en kopia: {err}");
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        return;
                    }
                    replica.backfill_blobs(200).await;
                }
                match replica.follow_once().await {
                    Ok(term) => {
                        node.term.store(term, Ordering::Relaxed);
                        let mut saved = node.saved.lock().unwrap();
                        if saved.term != term {
                            saved.term = term;
                            save(&node.data_dir, &saved);
                        }
                        return;
                    }
                    Err(err) if err == super::replica::GAP => {
                        let _ = replica.take_snapshot().await;
                        replica.backfill_blobs(200).await;
                        return;
                    }
                    Err(err) => eprintln!("[kluster] tappade värden: {err}"),
                }
            }
            // Reachable but serving a different office: this address is stale.
            Ok(_) => eprintln!("[kluster] {host} är ett annat kontor"),
            Err(_) => {}
        }
    }

    if office.is_empty() {
        tokio::time::sleep(Duration::from_secs(2)).await;
        return;
    }

    node.inner.lock().unwrap().role = Role::Seeking;

    // The host may only have been restarted; give it the full silence window
    // to come back before disturbing anyone.
    if let Some(found) = discovery::await_host(&office, discovery::HOST_SILENCE).await {
        node.term.store(found.term.max(node.term.load(Ordering::Relaxed)), Ordering::Relaxed);
        node.set_host(&found.url);
        return;
    }

    if token.is_empty() {
        // Never joined this office as a person, so there is nothing to serve
        // and no way to prove otherwise.
        tokio::time::sleep(Duration::from_secs(5)).await;
        return;
    }

    let me = node.candidate();
    match discovery::stand_for_election(&office, &me).await {
        Election::Won => {
            eprintln!("[kluster] tar över kontoret i omgång {}", me.term);
            if let Err(err) = node.promote(me.term).await {
                eprintln!("[kluster] kunde inte ta över: {err}");
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
        Election::Lost => {
            // Somebody better placed is taking it; their beacon will arrive.
            tokio::time::sleep(discovery::ELECTION_WINDOW).await;
        }
    }
}
