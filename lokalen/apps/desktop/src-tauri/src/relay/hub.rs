//! Presence tracking and message fan-out.
//!
//! A person may be signed in from several machines at once, so sockets are
//! tracked as a list per user id and every delivery goes to all of them -
//! including the sender's other devices, which keeps a conversation in sync
//! across the office and the phone in someone's pocket.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc::UnboundedSender;

use super::model::{ServerEvent, User};
use super::store::{list_users, Db};

/// One open socket. `id` distinguishes several sockets held by one person.
struct Socket {
    id: u64,
    presence: &'static str,
    tx: UnboundedSender<ServerEvent>,
}

#[derive(Clone, Default)]
pub struct Hub {
    sockets: Arc<Mutex<HashMap<String, Vec<Socket>>>>,
    next_id: Arc<Mutex<u64>>,
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn attach(&self, user_id: &str, tx: UnboundedSender<ServerEvent>) -> u64 {
        let id = {
            let mut next = self.next_id.lock().unwrap();
            *next += 1;
            *next
        };
        let mut sockets = self.sockets.lock().unwrap();
        sockets.entry(user_id.to_string()).or_default().push(Socket {
            id,
            presence: "online",
            tx,
        });
        id
    }

    /// Removes one socket. Returns true when that was the person's last one,
    /// i.e. when they have actually gone offline.
    pub fn detach(&self, user_id: &str, socket_id: u64) -> bool {
        let mut sockets = self.sockets.lock().unwrap();
        let Some(list) = sockets.get_mut(user_id) else {
            return false;
        };
        list.retain(|s| s.id != socket_id);
        if list.is_empty() {
            sockets.remove(user_id);
            return true;
        }
        false
    }

    /// Presence is derived from live sockets, never from a stale column.
    pub fn presence_of(&self, user_id: &str) -> &'static str {
        let sockets = self.sockets.lock().unwrap();
        match sockets.get(user_id) {
            None => "offline",
            Some(list) if list.is_empty() => "offline",
            Some(list) => {
                if list.iter().any(|s| s.presence == "online") {
                    "online"
                } else {
                    "away"
                }
            }
        }
    }

    pub fn set_presence(&self, user_id: &str, socket_id: u64, presence: &'static str) {
        let mut sockets = self.sockets.lock().unwrap();
        if let Some(list) = sockets.get_mut(user_id) {
            for socket in list.iter_mut() {
                if socket.id == socket_id {
                    socket.presence = presence;
                }
            }
        }
    }

    pub fn send_to(&self, user_id: &str, event: &ServerEvent) {
        let sockets = self.sockets.lock().unwrap();
        if let Some(list) = sockets.get(user_id) {
            for socket in list {
                let _ = socket.tx.send(event.clone());
            }
        }
    }

    /// Delivers to a person's other devices, and a different event to the
    /// socket that originated the action.
    pub fn send_to_others(&self, user_id: &str, except: u64, event: &ServerEvent) {
        let sockets = self.sockets.lock().unwrap();
        if let Some(list) = sockets.get(user_id) {
            for socket in list.iter().filter(|s| s.id != except) {
                let _ = socket.tx.send(event.clone());
            }
        }
    }

    pub fn send_to_socket(&self, user_id: &str, socket_id: u64, event: &ServerEvent) {
        let sockets = self.sockets.lock().unwrap();
        if let Some(list) = sockets.get(user_id) {
            for socket in list.iter().filter(|s| s.id == socket_id) {
                let _ = socket.tx.send(event.clone());
            }
        }
    }

    pub fn broadcast(&self, event: &ServerEvent) {
        let sockets = self.sockets.lock().unwrap();
        for list in sockets.values() {
            for socket in list {
                let _ = socket.tx.send(event.clone());
            }
        }
    }

    pub fn roster(&self, db: &Db) -> Vec<User> {
        list_users(db)
            .iter()
            .map(|row| row.to_user(self.presence_of(&row.id)))
            .collect()
    }

    pub fn online_count(&self) -> usize {
        self.sockets.lock().unwrap().len()
    }
}
