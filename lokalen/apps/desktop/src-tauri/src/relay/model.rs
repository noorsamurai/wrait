//! Wire types for the relay.
//!
//! These mirror `packages/protocol` exactly, so a client cannot tell whether
//! it is talking to the embedded Rust relay or the standalone Node one.

use serde::{Deserialize, Serialize};

/// 512 KiB, matching the client's uploader. Keeps peak memory low on the
/// machines this app is meant to run on.
pub const CHUNK_SIZE: u64 = 512 * 1024;
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const PROTOCOL_VERSION: u32 = 1;

/// How long after sending a message may still be deleted. Long enough to
/// catch "wrong room", short enough that the day's record does not quietly
/// change later.
pub const DELETE_WINDOW_MS: i64 = 5 * 60 * 1000;

/// The rooms a new office starts with. A room is a place, not a person.
pub const DEFAULT_ROOMS: [&str; 3] = ["Behandlingsrum 1", "Behandlingsrum 2", "Reception"];

/// The channel every room can see.
pub const BROADCAST_ROOM: &str = "Alla";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub username: String,
    /// The room's name, e.g. "Behandlingsrum 1".
    pub display_name: String,
    pub initials: String,
    pub presence: &'static str,
    /// "available" or "busy"; busy also silences that machine's own alerts.
    pub availability: String,
    /// Who is working in this room right now, if anyone said.
    pub operator: Option<String>,
    /// "room" or "broadcast".
    pub kind: String,
    pub last_seen: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub file_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub mime: String,
}

/// One earlier wording of a message, kept so an edit can be looked back at.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub body: String,
    pub replaced_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub client_id: Option<String>,
    pub from: String,
    pub to: String,
    pub body: String,
    pub attachment: Option<Attachment>,
    pub alert: bool,
    pub sent_at: i64,
    pub read_at: Option<i64>,
    pub edited_at: Option<i64>,
    pub deleted_at: Option<i64>,
    /// Every earlier wording, oldest first. Visible to both sides.
    pub revisions: Vec<Revision>,
}

/// How an office lets people in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OfficeMode {
    /// Type a name and start; nobody manages passwords.
    Open,
    /// Each person has an account, for shared or guest networks.
    Password,
}

impl OfficeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            OfficeMode::Open => "open",
            OfficeMode::Password => "password",
        }
    }

    pub fn parse(value: &str) -> Self {
        if value == "password" {
            OfficeMode::Password
        } else {
            OfficeMode::Open
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeInfo {
    pub name: String,
    pub mode: OfficeMode,
    pub version: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    /// Whose list this sits in.
    pub owner: String,
    /// Who put it there - the same as `owner` for a personal note.
    pub created_by: String,
    pub title: String,
    pub notes: String,
    pub due_at: Option<i64>,
    pub cleared_at: Option<i64>,
    pub created_at: i64,
    pub source_message_id: Option<String>,
}

/// Events the client sends. Unknown shapes deserialize to `Unknown` rather
/// than dropping the socket, so a newer client cannot break an older relay.
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClientEvent {
    #[serde(rename = "send")]
    Send {
        #[serde(default)]
        client_id: Option<String>,
        to: String,
        #[serde(default)]
        body: String,
        #[serde(default)]
        alert: bool,
        #[serde(default)]
        attachment: Option<Attachment>,
    },
    #[serde(rename = "typing")]
    Typing { to: String },
    #[serde(rename = "nudge")]
    Nudge { to: String },
    #[serde(rename = "read")]
    Read {
        with_user: String,
        #[serde(default)]
        up_to: i64,
    },
    #[serde(rename = "presence")]
    Presence { status: String },
    #[serde(rename = "availability")]
    Availability { availability: String },
    #[serde(rename = "operator")]
    Operator {
        #[serde(default)]
        name: Option<String>,
    },
    #[serde(rename = "history")]
    History {
        with_user: String,
        #[serde(default)]
        before: i64,
    },
    #[serde(rename = "taskAdd")]
    TaskAdd {
        #[serde(default)]
        owner: Option<String>,
        title: String,
        #[serde(default)]
        notes: Option<String>,
        #[serde(default)]
        due_at: Option<i64>,
        #[serde(default)]
        source_message_id: Option<String>,
    },
    #[serde(rename = "taskEdit")]
    TaskEdit {
        id: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        notes: Option<String>,
        #[serde(default)]
        due_at: Option<i64>,
    },
    #[serde(rename = "taskClear")]
    TaskClear { id: String, cleared: bool },
    #[serde(rename = "taskDelete")]
    TaskDelete { id: String },
    #[serde(rename = "messageEdit")]
    MessageEdit { id: String, body: String },
    #[serde(rename = "messageDelete")]
    MessageDelete { id: String },
    #[serde(rename = "search")]
    Search { query: String },
    #[serde(rename = "ping")]
    Ping,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ServerEvent {
    #[serde(rename = "ready")]
    Ready {
        version: u32,
        #[serde(rename = "self")]
        self_user: User,
        users: Vec<User>,
        history: Vec<Message>,
        tasks: Vec<Task>,
        office: OfficeInfo,
    },
    #[serde(rename = "task")]
    Task { task: Task },
    #[serde(rename = "messageUpdated")]
    MessageUpdated { message: Message },
    #[serde(rename = "searchResults")]
    SearchResults { query: String, messages: Vec<Message> },
    #[serde(rename = "taskRemoved")]
    TaskRemoved { id: String },
    #[serde(rename = "message")]
    Message { message: Message },
    #[serde(rename = "ack")]
    Ack {
        client_id: Option<String>,
        message: Message,
    },
    #[serde(rename = "presence")]
    Presence {
        user_id: String,
        presence: &'static str,
        availability: String,
        operator: Option<String>,
        last_seen: Option<i64>,
    },
    #[serde(rename = "history")]
    History {
        with_user: String,
        messages: Vec<Message>,
        exhausted: bool,
    },
    #[serde(rename = "roster")]
    Roster { users: Vec<User> },
    #[serde(rename = "typing")]
    Typing { from: String },
    #[serde(rename = "read")]
    Read { from: String, up_to: i64 },
    #[serde(rename = "nudge")]
    Nudge { from: String },
    #[serde(rename = "error")]
    Error { code: String, message: String },
    #[serde(rename = "pong")]
    Pong,
}

/// Two-letter monogram, derived the same way the client does it.
pub fn initials_of(display_name: &str) -> String {
    let parts: Vec<&str> = display_name.split_whitespace().collect();
    match parts.len() {
        0 => "?".to_string(),
        1 => parts[0].chars().take(2).collect::<String>().to_uppercase(),
        _ => {
            let first = parts[0].chars().next().unwrap_or('?');
            let last = parts[parts.len() - 1].chars().next().unwrap_or('?');
            format!("{first}{last}").to_uppercase()
        }
    }
}

pub fn chunk_count_for(size: u64) -> u64 {
    size.div_ceil(CHUNK_SIZE).max(1)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
