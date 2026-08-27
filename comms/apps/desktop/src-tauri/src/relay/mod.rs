//! The office relay, embedded in the application binary.
//!
//! Running this in-process is what lets a single portable .exe host an office
//! on its own: no Node, no database engine to install, nothing unpacked at
//! launch and nothing left behind on exit. SQLite is compiled in, and the
//! whole relay is a task on the app's own tokio runtime.

pub mod discovery;
pub mod files;
pub mod hub;
pub mod model;
pub mod routes;
pub mod store;

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use hub::Hub;
use routes::AppState;

/// What a caller needs to tell everyone else in the office.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayInfo {
    pub port: u16,
    /// Addresses other machines on the LAN can reach, most useful first.
    pub addresses: Vec<String>,
}

pub struct Relay {
    pub info: RelayInfo,
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
pub async fn start(port: u16, data_dir: &Path) -> Result<Relay, String> {
    let db = store::open(Some(&data_dir.join("comms.db"))).map_err(|e| e.to_string())?;
    let state = AppState {
        db,
        hub: Hub::new(),
        data_dir: Arc::new(PathBuf::from(data_dir)),
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
    let beacon = discovery::announce(bound, uuid::Uuid::new_v4().to_string());

    Ok(Relay {
        info: RelayInfo {
            port: bound,
            addresses: lan_addresses(bound),
        },
        shutdown,
        handle,
        beacon,
    })
}
