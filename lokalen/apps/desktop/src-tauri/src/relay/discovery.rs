//! Finding an office on the local network, and deciding who hosts it.
//!
//! Without the first part, someone has to read an IP address out loud and
//! everyone else types it in - the weakest part of an otherwise
//! double-click-and-go app. The scheme is the one LocalSend uses to good
//! effect, rewritten here rather than borrowed as code (it is Dart, and
//! accountless): the machine hosting an office answers probes on a well-known
//! UDP port, and clients shout once and collect the replies.
//!
//! The second part rides on the same socket. When the hosting computer is
//! switched off, the machines still running have to agree on which of them
//! takes over, and they have to do it without a coordinator - the coordinator
//! is exactly what just disappeared. So a machine that notices the silence
//! says out loud how much of the office's history it holds, listens for a
//! moment to hear whether anyone holds more, and only then starts serving.
//!
//! Everything goes out over BOTH multicast and broadcast, because plenty of
//! office access points and switches quietly drop one or the other.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::UdpSocket;

/// Administratively scoped multicast group (RFC 2365), plus a port unlikely to
/// collide. Deliberately not LocalSend's, so the two never answer each other.
const GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 77, 88);
const PORT: u16 = 45888;
const MAGIC: &str = "lokalen";
const ANNOUNCE_EVERY: Duration = Duration::from_secs(3);

/// How long a machine goes without hearing from the host before it considers
/// the office unhosted. Three missed announcements: long enough to ride out a
/// dropped packet or a laptop lid, short enough that nobody sits looking at a
/// dead window wondering whether to phone through instead.
pub const HOST_SILENCE: Duration = Duration::from_secs(10);

/// How long a machine listens for better-qualified candidates before it
/// promotes itself.
pub const ELECTION_WINDOW: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Packet {
    app: String,
    v: u32,
    /// "announce", "probe" or "claim".
    kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub port: u16,
    /// The office this is about, so two offices on one network ignore each
    /// other completely.
    #[serde(default)]
    pub id: String,
    /// Which round of hosting the sender is talking about.
    #[serde(default)]
    pub term: i64,
    /// How much of the office's log the sender holds. Only meaningful on a
    /// claim, where it is the whole basis for who wins.
    #[serde(default)]
    pub watermark: i64,
    /// The sending machine, used only to break a tie deterministically.
    #[serde(default)]
    pub instance: String,
}

impl Packet {
    fn new(kind: &str) -> Self {
        Self {
            app: MAGIC.into(),
            v: 1,
            kind: kind.into(),
            name: String::new(),
            port: 0,
            id: String::new(),
            term: 0,
            watermark: 0,
            instance: String::new(),
        }
    }

    fn ours(&self) -> bool {
        self.app == MAGIC
    }
}

/// What a hosting machine says about itself.
#[derive(Debug, Clone)]
pub struct Advert {
    pub port: u16,
    pub office: String,
    pub term: i64,
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
    /// Which round of hosting this is - higher wins, if two answer.
    pub term: i64,
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

async fn shout(socket: &UdpSocket, payload: &[u8]) {
    let _ = socket.send_to(payload, SocketAddr::from((GROUP, PORT))).await;
    let _ = socket
        .send_to(payload, SocketAddr::from((Ipv4Addr::BROADCAST, PORT)))
        .await;
}

/// The announcer a hosting machine runs.
pub struct Beacon {
    handle: tokio::task::JoinHandle<()>,
    advert: Arc<Mutex<Advert>>,
}

impl Beacon {
    pub fn stop(self) {
        self.handle.abort();
    }

    /// Used when a machine is promoted: the office is the same, the round is
    /// not.
    pub fn set_term(&self, term: i64) {
        self.advert.lock().unwrap().term = term;
    }
}

/// Starts answering discovery probes and announcing this office periodically.
///
/// Returns `None` when the port cannot be bound - discovery is a convenience,
/// so failing to announce must never stop the relay from serving.
pub fn announce(advert: Advert) -> Option<Beacon> {
    let socket = match reusable_socket(PORT) {
        Ok(socket) => socket,
        Err(err) => {
            eprintln!("[discovery] annonserar inte: {err}");
            return None;
        }
    };

    let advert = Arc::new(Mutex::new(advert));
    let shared = advert.clone();
    let name = host_name();

    let handle = tokio::spawn(async move {
        let mut buf = vec![0u8; 2048];
        let mut ticker = tokio::time::interval(ANNOUNCE_EVERY);

        loop {
            let payload = {
                let advert = shared.lock().unwrap();
                let mut packet = Packet::new("announce");
                packet.name = name.clone();
                packet.port = advert.port;
                packet.id = advert.office.clone();
                packet.term = advert.term;
                serde_json::to_vec(&packet).unwrap_or_default()
            };

            tokio::select! {
                // Answer a probe immediately, unicast, so a client that just
                // opened the app does not wait for the next beacon.
                received = socket.recv_from(&mut buf) => {
                    let Ok((len, from)) = received else { continue };
                    let Ok(probe) = serde_json::from_slice::<Packet>(&buf[..len]) else { continue };
                    if probe.ours() && probe.kind == "probe" {
                        let _ = socket.send_to(&payload, from).await;
                    }
                }
                _ = ticker.tick() => shout(&socket, &payload).await,
            }
        }
    });

    Some(Beacon { handle, advert })
}

/// Shouts once and collects whatever answers within `window`.
pub async fn discover(window: Duration) -> Vec<DiscoveredOffice> {
    // Ephemeral port: a client neither needs nor wants the well-known one.
    let Ok(socket) = reusable_socket(0) else {
        return Vec::new();
    };

    let probe = serde_json::to_vec(&Packet::new("probe")).unwrap_or_default();
    shout(&socket, &probe).await;

    let mut found: Vec<DiscoveredOffice> = Vec::new();
    let mut buf = vec![0u8; 2048];
    let deadline = tokio::time::Instant::now() + window;

    while let Ok(Ok((len, from))) =
        tokio::time::timeout_at(deadline, socket.recv_from(&mut buf)).await
    {
        let Ok(packet) = serde_json::from_slice::<Packet>(&buf[..len]) else {
            continue;
        };
        if !packet.ours() || packet.kind != "announce" || packet.port == 0 {
            continue;
        }

        // The address to dial is where the reply came from, not anything the
        // packet claims - a host cannot advertise someone else's machine.
        let office = DiscoveredOffice {
            id: packet.id.clone(),
            name: packet.name.clone(),
            url: format!("http://{}:{}", from.ip(), packet.port),
            term: packet.term,
        };
        match found.iter_mut().find(|o| o.id == office.id) {
            // Two answers for one office means a handover is in progress;
            // the later round is the one to join.
            Some(existing) if office.term > existing.term => *existing = office,
            Some(_) => {}
            None => found.push(office),
        }
    }

    found
}

/* ------------------------------------------------------------------ */
/* Standing for election                                               */
/* ------------------------------------------------------------------ */

/// What a machine says about itself when it offers to take over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub term: i64,
    pub watermark: i64,
    pub instance: String,
}

/// Whether `mine` should defer to `other`.
///
/// Most of the office's history wins, because a machine that has seen more is
/// the one that can carry on with the least lost. The instance id only ever
/// settles a tie between two machines holding exactly the same log, where the
/// choice does not matter but has to be the same on both.
pub fn defers_to(mine: &Candidate, other: &Candidate) -> bool {
    (other.term, other.watermark, other.instance.as_str())
        > (mine.term, mine.watermark, mine.instance.as_str())
}

/// The outcome of offering to take over.
#[derive(Debug, PartialEq, Eq)]
pub enum Election {
    /// Nobody better answered: start serving.
    Won,
    /// Another machine holds more of the office, or is already hosting it.
    Lost,
}

/// Says out loud that this machine could host, and listens for a better offer.
///
/// A machine that hears an announcement for its own office during the window
/// loses outright: somebody is already serving, and joining them is always
/// better than a second host.
pub async fn stand_for_election(office: &str, me: &Candidate) -> Election {
    let Ok(socket) = reusable_socket(0) else {
        // Without a socket this machine cannot be told that someone else is
        // better placed, so it must not promote itself.
        return Election::Lost;
    };

    let mut claim = Packet::new("claim");
    claim.id = office.to_string();
    claim.term = me.term;
    claim.watermark = me.watermark;
    claim.instance = me.instance.clone();
    let payload = serde_json::to_vec(&claim).unwrap_or_default();
    shout(&socket, &payload).await;

    let deadline = tokio::time::Instant::now() + ELECTION_WINDOW;
    let mut buf = vec![0u8; 2048];

    while let Ok(Ok((len, _))) = tokio::time::timeout_at(deadline, socket.recv_from(&mut buf)).await
    {
        let Ok(packet) = serde_json::from_slice::<Packet>(&buf[..len]) else {
            continue;
        };
        if !packet.ours() || packet.id != office {
            continue;
        }
        match packet.kind.as_str() {
            "announce" => return Election::Lost,
            "claim" if packet.instance != me.instance => {
                let other = Candidate {
                    term: packet.term,
                    watermark: packet.watermark,
                    instance: packet.instance,
                };
                if defers_to(me, &other) {
                    return Election::Lost;
                }
            }
            _ => {}
        }
    }

    Election::Won
}

/// Waits for the machine hosting `office` to announce itself.
///
/// Returns the address to dial, or `None` if the office stayed silent for
/// `window` - which is the signal to stand for election.
pub async fn await_host(office: &str, window: Duration) -> Option<DiscoveredOffice> {
    let socket = reusable_socket(0).ok()?;
    let probe = serde_json::to_vec(&Packet::new("probe")).unwrap_or_default();
    shout(&socket, &probe).await;

    let deadline = tokio::time::Instant::now() + window;
    let mut buf = vec![0u8; 2048];

    while let Ok(Ok((len, from))) =
        tokio::time::timeout_at(deadline, socket.recv_from(&mut buf)).await
    {
        let Ok(packet) = serde_json::from_slice::<Packet>(&buf[..len]) else {
            continue;
        };
        if packet.ours() && packet.kind == "announce" && packet.id == office && packet.port != 0 {
            return Some(DiscoveredOffice {
                id: packet.id.clone(),
                name: packet.name.clone(),
                url: format!("http://{}:{}", from.ip(), packet.port),
                term: packet.term,
            });
        }
    }

    None
}
