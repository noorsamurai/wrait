//! The office relay, embedded in the application binary.
//!
//! Running this in-process is what lets a single portable .exe host an office
//! on its own: no Node, no database engine to install, nothing unpacked at
//! launch and nothing left behind on exit. SQLite is compiled in, and the
//! whole relay is a task on the app's own tokio runtime.

pub mod backup;
pub mod cluster;
pub mod discovery;
pub mod files;
pub mod hub;
pub mod model;
pub mod oplog;
pub mod routes;
pub mod replica;
pub mod store;

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use hub::Hub;
use model::OfficeMode;
use routes::AppState;
use store::Db;

/// What a caller needs to tell everyone else in the office.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayInfo {
    pub port: u16,
    /// What this office is called, shown to people joining it.
    pub name: String,
    /// "open" (name only) or "password".
    pub mode: String,
    /// Addresses other machines on the LAN can reach, most useful first.
    pub addresses: Vec<String>,
}

pub struct Relay {
    pub info: RelayInfo,
    /// The office as this machine holds it. Shared with the standby machinery
    /// so hosting and replicating are two roles over one database, not two
    /// databases.
    pub db: Db,
    shutdown: tokio::sync::oneshot::Sender<()>,
    handle: tokio::task::JoinHandle<()>,
    beacon: Option<discovery::Beacon>,
}

impl Relay {
    /// Stops announcing, stops the relay, and waits for the listener to close.
    pub async fn stop(self) {
        if let Some(beacon) = self.beacon {
            beacon.stop();
        }
        let _ = self.shutdown.send(());
        let _ = self.handle.await;
    }
}

/// Best-effort LAN addresses, so the host can read one out to colleagues.
pub fn lan_addresses(port: u16) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(interfaces) = local_ip_address::list_afinet_netifas() {
        for (_, ip) in interfaces {
            if let std::net::IpAddr::V4(v4) = ip {
                if !v4.is_loopback() && !v4.is_link_local() {
                    out.push(format!("http://{v4}:{port}"));
                }
            }
        }
    }
    out.push(format!("http://127.0.0.1:{port}"));
    out
}

/// Starts the relay on `port`, storing its database and file blobs under
/// `data_dir`. Pass port 0 to let the OS choose a free one.
pub async fn start(
    port: u16,
    data_dir: &Path,
    mode: OfficeMode,
    office_name: &str,
) -> Result<Relay, String> {
    let db = store::open(Some(&data_dir.join("lokalen.db"))).map_err(|e| e.to_string())?;
    start_with(db, port, data_dir, mode, office_name, 1).await
}

/// Starts serving an office this machine already holds.
///
/// Taking the database as an argument is what lets a standby be promoted: it
/// has been following the office all along, and hosting is then only a matter
/// of binding a port to the copy it already has.
pub async fn start_with(
    db: Db,
    port: u16,
    data_dir: &Path,
    mode: OfficeMode,
    office_name: &str,
    term: i64,
) -> Result<Relay, String> {
    store::init_office(&db, mode, office_name);
    // Every office starts with its rooms and the Alla channel present.
    store::seed_rooms(&db);
    let office = store::office_info(&db);
    let state = AppState {
        db: db.clone(),
        hub: Hub::new(),
        data_dir: Arc::new(PathBuf::from(data_dir)),
        term: Arc::new(std::sync::atomic::AtomicI64::new(term)),
    };

    let listener = tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))
        .await
        .map_err(|e| format!("Could not listen on port {port}: {e}"))?;

    let bound = listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| e.to_string())?;

    let (shutdown, rx) = tokio::sync::oneshot::channel();
    let app = routes::router(state);

    let handle = tokio::spawn(async move {
        let served = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = rx.await;
        });
        if let Err(err) = served.await {
            eprintln!("[relay] stopped: {err}");
        }
    });

    // Announcing is a convenience: if the discovery port is unavailable the
    // relay still serves, people just have to type the address.
    let beacon = discovery::announce(discovery::Advert {
        port: bound,
        office: store::office_id(&db),
        term,
    });

    Ok(Relay {
        info: RelayInfo {
            port: bound,
            name: office.name,
            mode: office.mode.as_str().to_string(),
            addresses: lan_addresses(bound),
        },
        db,
        shutdown,
        handle,
        beacon,
    })
}
