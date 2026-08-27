//! Finding an office on the local network.
//!
//! Without this, someone has to read an IP address out loud and everyone else
//! types it in - the weakest part of an otherwise double-click-and-go app.
//!
//! The scheme is the one LocalSend uses to good effect, rewritten here rather
//! than borrowed as code (it is Dart, and accountless): a host that is serving
//! an office answers probes on a well-known UDP port, and clients shout once
//! and collect the replies.
//!
//! Probes go out over BOTH multicast and broadcast, because plenty of office
//! access points and switches quietly drop one or the other.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::UdpSocket;

/// Administratively scoped multicast group (RFC 2365), plus a port unlikely to
/// collide. Deliberately not LocalSend's, so the two never answer each other.
const GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 77, 88);
const PORT: u16 = 45888;
const MAGIC: &str = "wrait-comms";
const ANNOUNCE_EVERY: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Packet {
    app: String,
    v: u32,
    kind: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    id: String,
}

/// An office found on this network.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredOffice {
    pub id: String,
    /// The hosting computer's name, for the "join this one?" list.
    pub name: String,
    /// Ready to paste into the server field.
    pub url: String,
}

fn host_name() -> String {
    gethostname::gethostname()
        .into_string()
        .unwrap_or_else(|_| "Office".into())
}

/// Binds a UDP socket that tolerates another process already using the port,
/// which std's plain `bind` will not do.
fn reusable_socket(port: u16) -> std::io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    // Two apps on one machine (a host and a client) must both be able to bind.
    #[cfg(all(unix, not(target_os = "solaris")))]
    socket.set_reuse_port(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port).into())?;

    let std_socket: std::net::UdpSocket = socket.into();
    // Best effort: a machine with no multicast-capable interface still works
    // over broadcast.
    let _ = std_socket.join_multicast_v4(&GROUP, &Ipv4Addr::UNSPECIFIED);
    std_socket.set_broadcast(true)?;
    UdpSocket::from_std(std_socket)
}

/// The announcer a hosting machine runs.
pub struct Beacon {
    handle: tokio::task::JoinHandle<()>,
}

impl Beacon {
    pub fn stop(self) {
        self.handle.abort();
    }
}

/// Starts answering discovery probes and announcing this office periodically.
///
/// Returns `None` when the port cannot be bound - discovery is a convenience,
/// so failing to announce must never stop the relay from serving.
pub fn announce(relay_port: u16, id: String) -> Option<Beacon> {
    let socket = match reusable_socket(PORT) {
        Ok(socket) => socket,
        Err(err) => {
            eprintln!("[discovery] not announcing: {err}");
            return None;
        }
    };

    let packet = Packet {
        app: MAGIC.into(),
        v: 1,
        kind: "announce".into(),
        name: host_name(),
        port: relay_port,
        id,
    };

    let handle = tokio::spawn(async move {
        let payload = serde_json::to_vec(&packet).unwrap_or_default();
        let mut buf = vec![0u8; 2048];
        let mut ticker = tokio::time::interval(ANNOUNCE_EVERY);

        loop {
            tokio::select! {
                // Answer a probe immediately, unicast, so a client that just
                // opened the app does not wait for the next beacon.
                received = socket.recv_from(&mut buf) => {
                    let Ok((len, from)) = received else { continue };
                    let Ok(probe) = serde_json::from_slice::<Packet>(&buf[..len]) else { continue };
                    if probe.app == MAGIC && probe.kind == "probe" {
                        let _ = socket.send_to(&payload, from).await;
                    }
                }
                _ = ticker.tick() => {
                    let multicast = SocketAddr::from((GROUP, PORT));
                    let broadcast = SocketAddr::from((Ipv4Addr::BROADCAST, PORT));
                    let _ = socket.send_to(&payload, multicast).await;
                    let _ = socket.send_to(&payload, broadcast).await;
                }
            }
        }
    });

    Some(Beacon { handle })
}

/// Shouts once and collects whatever answers within `window`.
pub async fn discover(window: Duration) -> Vec<DiscoveredOffice> {
    // Ephemeral port: a client neither needs nor wants the well-known one.
    let Ok(socket) = reusable_socket(0) else {
        return Vec::new();
    };

    let probe = serde_json::to_vec(&Packet {
        app: MAGIC.into(),
        v: 1,
        kind: "probe".into(),
        name: String::new(),
        port: 0,
        id: String::new(),
    })
    .unwrap_or_default();

    let _ = socket.send_to(&probe, SocketAddr::from((GROUP, PORT))).await;
    let _ = socket
        .send_to(&probe, SocketAddr::from((Ipv4Addr::BROADCAST, PORT)))
        .await;

    let mut found: Vec<DiscoveredOffice> = Vec::new();
    let mut buf = vec![0u8; 2048];
    let deadline = tokio::time::Instant::now() + window;

    while let Ok(Ok((len, from))) =
        tokio::time::timeout_at(deadline, socket.recv_from(&mut buf)).await
    {
        let Ok(packet) = serde_json::from_slice::<Packet>(&buf[..len]) else {
            continue;
        };
        if packet.app != MAGIC || packet.kind != "announce" || packet.port == 0 {
            continue;
        }

        // The address to dial is where the reply came from, not anything the
        // packet claims - a host cannot advertise someone else's machine.
        let office = DiscoveredOffice {
            id: packet.id.clone(),
            name: packet.name.clone(),
            url: format!("http://{}:{}", from.ip(), packet.port),
        };
        if !found.iter().any(|o| o.id == office.id || o.url == office.url) {
            found.push(office);
        }
    }

    found
}
