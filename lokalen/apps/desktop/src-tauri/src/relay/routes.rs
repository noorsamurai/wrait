//! HTTP and WebSocket surface. Mirrors the Node relay's routes exactly.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};

use super::files;
use super::hub::Hub;
use super::model::*;
use super::store::{self, Db};

const MAX_BODY_LENGTH: usize = 8000;
const HISTORY_LIMIT: i64 = 500;
const TASK_LIMIT: i64 = 500;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub hub: Hub,
    pub data_dir: Arc<PathBuf>,
}

fn fail(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": code, "message": message }))).into_response()
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::to_string)
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<store::UserRow, Response> {
    bearer(headers)
        .and_then(|t| store::resolve_session(&state.db, &t))
        .ok_or_else(|| fail(StatusCode::UNAUTHORIZED, "unauthorized", "Logga in för att fortsätta."))
}

pub fn router(state: AppState) -> Router {
    // The desktop and iOS shells load the UI from a custom scheme, so the API
    // is always cross-origin from the webview's point of view.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_headers(Any)
        .allow_methods(Any);

    Router::new()
        .route("/api/health", get(health))
        // Public: a client must know which sign-in screen to show before it
        // has any credentials.
        .route("/api/office", get(office))
        .route("/api/join", post(join))
        .route("/api/register", post(register))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/directory", get(directory))
        .route("/api/files/init", post(file_init))
        .route("/api/files/{id}/chunk", put(file_chunk))
        .route("/api/files/{id}", get(file_download))
        .route("/ws", get(ws_upgrade))
        .layer(cors)
        .with_state(state)
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

async fn health(State(state): State<AppState>) -> Response {
    Json(json!({ "ok": true, "users": state.hub.online_count() })).into_response()
}

async fn register(State(state): State<AppState>, body: String) -> Response {
    if store::office_info(&state.db).mode != OfficeMode::Password {
        return fail(
            StatusCode::FORBIDDEN,
            "open_office",
            "Det här kontoret använder bara namn - inga konton.",
        );
    }
    let Ok(body) = serde_json::from_str::<serde_json::Value>(&body) else {
        return fail(StatusCode::BAD_REQUEST, "bad_json", "Ogiltigt JSON-innehåll.");
    };
    let username = body.get("username").and_then(|v| v.as_str()).unwrap_or("");
    let password = body.get("password").and_then(|v| v.as_str()).unwrap_or("");
    let display_name = body
        .get("displayName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if !store::username_valid(username) {
        return fail(
            StatusCode::BAD_REQUEST,
            "invalid",
            "Användarnamnet måste vara 3-32 tecken: bokstäver, siffror, punkt, bindestreck eller understreck.",
        );
    }
    if password.chars().count() < 8 {
        return fail(StatusCode::BAD_REQUEST, "invalid", "Lösenordet måste vara minst 8 tecken.");
    }
    if password.chars().count() > 256 {
        return fail(StatusCode::BAD_REQUEST, "invalid", "Lösenordet är för långt.");
    }

    let display: String = if display_name.is_empty() { username } else { display_name }
        .chars()
        .take(64)
        .collect();

    match store::create_user(&state.db, username, &display, password) {
        store::CreateUser::Taken => {
            fail(StatusCode::CONFLICT, "taken", "Användarnamnet är upptaget.")
        }
        store::CreateUser::Created(id) => {
            let Some(row) = store::find_by_id(&state.db, &id) else {
                return fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Kunde inte skapa kontot.");
            };
            let token = store::create_session(&state.db, &id);
            state.hub.broadcast(&ServerEvent::Roster {
                users: state.hub.roster(&state.db),
            });
            (
                StatusCode::CREATED,
                Json(json!({ "token": token, "user": row.to_user("offline") })),
            )
                .into_response()
        }
    }
}

async fn login(State(state): State<AppState>, body: String) -> Response {
    let Ok(body) = serde_json::from_str::<serde_json::Value>(&body) else {
        return fail(StatusCode::BAD_REQUEST, "bad_json", "Ogiltigt JSON-innehåll.");
    };
    let username = body.get("username").and_then(|v| v.as_str()).unwrap_or("");
    let password = body.get("password").and_then(|v| v.as_str()).unwrap_or("");

    let row = store::find_by_username(&state.db, username)
        // An account created by name-only join has no password and must never
        // be reachable through the password path.
        .filter(|r| !r.pw_hash.is_empty());
    // Always run a verification so a missing account and a wrong password take
    // the same amount of time.
    let ok = match &row {
        Some(r) => store::verify_password(password, &r.pw_hash, &r.pw_salt),
        None => {
            let (decoy_hash, decoy_salt) = store::hash_password("decoy");
            store::verify_password(password, &decoy_hash, &decoy_salt);
            false
        }
    };

    match (row, ok) {
        (Some(row), true) => {
            let token = store::create_session(&state.db, &row.id);
            let presence = state.hub.presence_of(&row.id);
            Json(json!({ "token": token, "user": row.to_user(presence) })).into_response()
        }
        _ => fail(
            StatusCode::UNAUTHORIZED,
            "bad_credentials",
            "Fel användarnamn eller lösenord.",
        ),
    }
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(token) = bearer(&headers) {
        store::destroy_session(&state.db, &token);
    }
    Json(json!({ "ok": true })).into_response()
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match require_user(&state, &headers) {
        Err(response) => response,
        Ok(row) => {
            let presence = state.hub.presence_of(&row.id);
            Json(row.to_user(presence)).into_response()
        }
    }
}

async fn directory(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match require_user(&state, &headers) {
        Err(response) => response,
        Ok(_) => Json(json!({ "users": state.hub.roster(&state.db) })).into_response(),
    }
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

async fn file_init(State(state): State<AppState>, headers: HeaderMap, body: String) -> Response {
    let user = match require_user(&state, &headers) {
        Err(response) => return response,
        Ok(user) => user,
    };
    let Ok(body) = serde_json::from_str::<serde_json::Value>(&body) else {
        return fail(StatusCode::BAD_REQUEST, "bad_json", "Ogiltigt JSON-innehåll.");
    };

    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
    let size = body.get("size").and_then(|v| v.as_i64()).unwrap_or(-1);
    let mime = body
        .get("mime")
        .and_then(|v| v.as_str())
        .unwrap_or("application/octet-stream");
    let to = body.get("to").and_then(|v| v.as_str()).unwrap_or("");

    if name.is_empty() {
        return fail(StatusCode::BAD_REQUEST, "bad_request", "Ett filnamn krävs.");
    }
    if size < 0 {
        return fail(StatusCode::BAD_REQUEST, "bad_request", "Ogiltig filstorlek.");
    }
    if size as u64 > MAX_FILE_BYTES {
        return fail(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_large",
            "Filen är större än gränsen på 2 GB.",
        );
    }
    if !store::user_exists(&state.db, to) {
        return fail(StatusCode::NOT_FOUND, "no_such_user", "Mottagaren finns inte längre.");
    }

    match files::init_upload(&state.db, &state.data_dir, &user.id, name, size, mime, to) {
        Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Kunde inte starta uppladdningen."),
        Ok(file_id) => (
            StatusCode::CREATED,
            Json(json!({ "fileId": file_id, "chunkSize": CHUNK_SIZE, "received": [] })),
        )
            .into_response(),
    }
}

async fn office(State(state): State<AppState>) -> Response {
    Json(store::office_info(&state.db)).into_response()
}

/// Name-only entry, for an office running in open mode.
///
/// A name already in the directory is reclaimed rather than duplicated - the
/// same person on a new machine keeps their history - but only while nobody
/// is signed in under it, so two people cannot hold one identity at once.
async fn join(State(state): State<AppState>, body: String) -> Response {
    if store::office_info(&state.db).mode != OfficeMode::Open {
        return fail(StatusCode::FORBIDDEN, "closed", "Det här kontoret kräver ett konto.");
    }

    let display_name = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("displayName").and_then(|d| d.as_str()).map(str::to_string))
        .unwrap_or_default()
        .trim()
        .chars()
        .take(64)
        .collect::<String>();

    if display_name.is_empty() {
        return fail(StatusCode::BAD_REQUEST, "invalid", "Skriv ett namn.");
    }

    if let Some(existing) = store::find_by_display_name(&state.db, &display_name) {
        if state.hub.presence_of(&existing.id) != "offline" {
            return fail(
                StatusCode::CONFLICT,
                "name_taken",
                "Någon använder det namnet just nu. Välj ett annat.",
            );
        }
        let token = store::create_session(&state.db, &existing.id);
        return Json(json!({ "token": token, "user": existing.to_user("offline") })).into_response();
    }

    let Some(id) = store::create_guest(&state.db, &display_name) else {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Kunde inte skapa användaren.");
    };
    let Some(row) = store::find_by_id(&state.db, &id) else {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Kunde inte skapa användaren.");
    };
    let token = store::create_session(&state.db, &id);
    state.hub.broadcast(&ServerEvent::Roster {
        users: state.hub.roster(&state.db),
    });
    (
        StatusCode::CREATED,
        Json(json!({ "token": token, "user": row.to_user("offline") })),
    )
        .into_response()
}

#[derive(Deserialize)]
struct ChunkQuery {
    index: i64,
}

async fn file_chunk(
    State(state): State<AppState>,
    Path(file_id): Path<String>,
    Query(query): Query<ChunkQuery>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let user = match require_user(&state, &headers) {
        Err(response) => return response,
        Ok(user) => user,
    };
    let Some(file) = files::get(&state.db, &file_id) else {
        return fail(StatusCode::NOT_FOUND, "not_found", "Okänd uppladdning.");
    };
    if file.owner_id != user.id {
        return fail(StatusCode::FORBIDDEN, "forbidden", "Uppladdningen tillhör någon annan.");
    }
    if file.complete {
        return Json(json!({
            "complete": true,
            "received": files::received_chunks(&state.db, &file_id)
        }))
        .into_response();
    }

    match files::write_chunk(&state.db, &state.data_dir, &file, query.index, &body) {
        Err(message) => fail(StatusCode::BAD_REQUEST, "bad_chunk", &message),
        Ok(result) => Json(json!({ "complete": result.complete, "received": result.received }))
            .into_response(),
    }
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

async fn file_download(
    State(state): State<AppState>,
    Path(file_id): Path<String>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
) -> Response {
    // Downloads are also reachable from an <a href> or a native save dialog,
    // which cannot set an Authorization header, so a token query param works.
    let token = bearer(&headers).or(query.token).unwrap_or_default();
    let Some(user) = store::resolve_session(&state.db, &token) else {
        return fail(StatusCode::UNAUTHORIZED, "unauthorized", "Logga in för att fortsätta.");
    };
    let Some(file) = files::get(&state.db, &file_id) else {
        return fail(StatusCode::NOT_FOUND, "not_found", "Filen finns inte längre.");
    };
    if file.owner_id != user.id && file.to_id != user.id {
        return fail(StatusCode::FORBIDDEN, "forbidden", "Filen har inte delats med dig.");
    }
    if !file.complete {
        return fail(StatusCode::CONFLICT, "incomplete", "Filen laddas fortfarande upp.");
    }

    match files::read_blob(&state.data_dir, &file) {
        Err(_) => fail(StatusCode::NOT_FOUND, "not_found", "Filen finns inte längre."),
        Ok(bytes) => {
            let disposition = format!("attachment; filename=\"{}\"", file.name.replace('"', ""));
            Response::builder()
                .header(header::CONTENT_TYPE, file.mime)
                .header(header::CONTENT_LENGTH, bytes.len())
                .header(header::CONTENT_DISPOSITION, disposition)
                .body(Body::from(bytes))
                .unwrap_or_else(|_| {
                    fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Kunde inte skicka filen.")
                })
        }
    }
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

async fn ws_upgrade(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let token = params.get("token").cloned().unwrap_or_default();
    let Some(user) = store::resolve_session(&state.db, &token) else {
        return fail(StatusCode::UNAUTHORIZED, "unauthorized", "Logga in för att fortsätta.");
    };
    upgrade.on_upgrade(move |socket| handle_socket(socket, state, user.id))
}

async fn handle_socket(socket: WebSocket, state: AppState, user_id: String) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ServerEvent>();

    let was_offline = state.hub.presence_of(&user_id) == "offline";
    let socket_id = state.hub.attach(&user_id, tx);
    store::touch_user(&state.db, &user_id);

    // One task owns the sink; everything else queues through the channel.
    let writer = tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let Ok(text) = serde_json::to_string(&event) else {
                continue;
            };
            if sink.send(WsMessage::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    if let Some(row) = store::find_by_id(&state.db, &user_id) {
        state.hub.send_to_socket(
            &user_id,
            socket_id,
            &ServerEvent::Ready {
                version: PROTOCOL_VERSION,
                self_user: row.to_user("online"),
                users: state.hub.roster(&state.db),
                history: store::recent_history(&state.db, &user_id, HISTORY_LIMIT),
                tasks: store::tasks_for(&state.db, &user_id, TASK_LIMIT),
                office: store::office_info(&state.db),
            },
        );
    }

    if was_offline {
        state.hub.broadcast(&ServerEvent::Presence {
            user_id: user_id.clone(),
            presence: "online",
            last_seen: Some(now_ms()),
        });
    }

    while let Some(Ok(frame)) = stream.next().await {
        let WsMessage::Text(text) = frame else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<ClientEvent>(&text) else {
            state.hub.send_to_socket(
                &user_id,
                socket_id,
                &ServerEvent::Error {
                    code: "bad_json".into(),
                    message: "Ogiltigt meddelande.".into(),
                },
            );
            continue;
        };
        handle_event(&state, &user_id, socket_id, event);
    }

    // Socket closed.
    let now = now_ms();
    store::touch_user(&state.db, &user_id);
    if state.hub.detach(&user_id, socket_id) {
        state.hub.broadcast(&ServerEvent::Presence {
            user_id: user_id.clone(),
            presence: "offline",
            last_seen: Some(now),
        });
    }
    writer.abort();
}

fn handle_event(state: &AppState, user_id: &str, socket_id: u64, event: ClientEvent) {
    match event {
        ClientEvent::Ping => {
            state.hub.send_to_socket(user_id, socket_id, &ServerEvent::Pong);
        }

        ClientEvent::Typing { to } => {
            state.hub.send_to(
                &to,
                &ServerEvent::Typing {
                    from: user_id.to_string(),
                },
            );
        }

        ClientEvent::Nudge { to } => {
            if store::user_exists(&state.db, &to) {
                state.hub.send_to(
                    &to,
                    &ServerEvent::Nudge {
                        from: user_id.to_string(),
                    },
                );
            }
        }

        ClientEvent::Read { with_user, up_to } => {
            let up_to = if up_to > 0 { up_to } else { now_ms() };
            store::mark_read(&state.db, user_id, &with_user, up_to);
            state.hub.send_to(
                &with_user,
                &ServerEvent::Read {
                    from: user_id.to_string(),
                    up_to,
                },
            );
        }

        ClientEvent::Presence { status } => {
            let presence = if status == "away" { "away" } else { "online" };
            state.hub.set_presence(user_id, socket_id, presence);
            state.hub.broadcast(&ServerEvent::Presence {
                user_id: user_id.to_string(),
                presence: state.hub.presence_of(user_id),
                last_seen: Some(now_ms()),
            });
        }

        ClientEvent::Send {
            client_id,
            to,
            body,
            alert,
            attachment,
        } => send_message(state, user_id, socket_id, client_id, to, body, alert, attachment),

        ClientEvent::TaskAdd {
            owner,
            title,
            notes,
            due_at,
            source_message_id,
        } => {
            let title: String = title.trim().chars().take(300).collect();
            if title.is_empty() {
                return error_to(state, user_id, socket_id, "empty", "Uppgiften behöver en rubrik.");
            }
            let owner = owner.unwrap_or_else(|| user_id.to_string());
            if !store::user_exists(&state.db, &owner) {
                return error_to(state, user_id, socket_id, "no_such_user", "Personen finns inte längre.");
            }
            let notes: String = notes.unwrap_or_default().chars().take(2000).collect();
            if let Some(task) = store::insert_task(
                &state.db,
                &owner,
                user_id,
                &title,
                &notes,
                due_at,
                source_message_id.as_deref(),
            ) {
                fan_out_task(state, &task);
            }
        }

        ClientEvent::TaskEdit {
            id,
            title,
            notes,
            due_at,
        } => {
            let Some(task) = owned_task(state, &id, user_id, socket_id) else {
                return;
            };
            let title: Option<String> = title
                .map(|t| t.trim().chars().take(300).collect())
                .filter(|t: &String| !t.is_empty());
            let notes: Option<String> = notes.map(|n| n.chars().take(2000).collect());
            store::edit_task(&state.db, &task.id, title.as_deref(), notes.as_deref(), Some(due_at));
            if let Some(updated) = store::get_task(&state.db, &task.id) {
                fan_out_task(state, &updated);
            }
        }

        ClientEvent::TaskClear { id, cleared } => {
            let Some(task) = owned_task(state, &id, user_id, socket_id) else {
                return;
            };
            store::set_task_cleared(&state.db, &task.id, cleared);
            if let Some(updated) = store::get_task(&state.db, &task.id) {
                fan_out_task(state, &updated);
            }
        }

        ClientEvent::TaskDelete { id } => {
            let Some(task) = owned_task(state, &id, user_id, socket_id) else {
                return;
            };
            store::delete_task(&state.db, &task.id);
            for who in [task.owner.as_str(), task.created_by.as_str()] {
                state.hub.send_to(who, &ServerEvent::TaskRemoved { id: task.id.clone() });
            }
        }

        ClientEvent::Unknown => {
            state.hub.send_to_socket(
                user_id,
                socket_id,
                &ServerEvent::Error {
                    code: "unknown_event".into(),
                    message: "Okänd händelse.".into(),
                },
            );
        }
    }
}

fn error_to(state: &AppState, user_id: &str, socket_id: u64, code: &str, message: &str) {
    state.hub.send_to_socket(
        user_id,
        socket_id,
        &ServerEvent::Error {
            code: code.into(),
            message: message.into(),
        },
    );
}

/// Both sides of a task see it: whoever owns it and whoever sent it.
fn fan_out_task(state: &AppState, task: &Task) {
    state.hub.send_to(&task.owner, &ServerEvent::Task { task: task.clone() });
    if task.created_by != task.owner {
        state
            .hub
            .send_to(&task.created_by, &ServerEvent::Task { task: task.clone() });
    }
}

/// Only the owner or the sender may change a task.
fn owned_task(state: &AppState, id: &str, user_id: &str, socket_id: u64) -> Option<Task> {
    match store::get_task(&state.db, id) {
        Some(task) if task.owner == user_id || task.created_by == user_id => Some(task),
        _ => {
            error_to(state, user_id, socket_id, "forbidden", "Den uppgiften är inte din.");
            None
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn send_message(
    state: &AppState,
    user_id: &str,
    socket_id: u64,
    client_id: Option<String>,
    to: String,
    body: String,
    alert: bool,
    attachment: Option<Attachment>,
) {
    let body: String = body.chars().take(MAX_BODY_LENGTH).collect();
    let file_id = attachment.as_ref().map(|a| a.file_id.clone());

    if body.trim().is_empty() && file_id.is_none() {
        state.hub.send_to_socket(
            user_id,
            socket_id,
            &ServerEvent::Error {
                code: "empty".into(),
                message: "Inget att skicka.".into(),
            },
        );
        return;
    }

    if !store::user_exists(&state.db, &to) {
        state.hub.send_to_socket(
            user_id,
            socket_id,
            &ServerEvent::Error {
                code: "no_such_user".into(),
                message: "Personen finns inte längre i katalogen.".into(),
            },
        );
        return;
    }

    // An attachment is only accepted if this sender uploaded it, it is fully
    // received, and it was addressed to this recipient.
    if let Some(id) = &file_id {
        let usable = files::get(&state.db, id)
            .is_some_and(|f| f.owner_id == user_id && f.to_id == to && f.complete);
        if !usable {
            state.hub.send_to_socket(
                user_id,
                socket_id,
                &ServerEvent::Error {
                    code: "bad_attachment".into(),
                    message: "Filen är inte klar att skickas.".into(),
                },
            );
            return;
        }
    }

    let client_id: Option<String> = client_id.map(|c| c.chars().take(64).collect());
    let Some(message) = store::insert_message(
        &state.db,
        client_id.as_deref(),
        user_id,
        &to,
        &body,
        alert,
        file_id.as_deref(),
    ) else {
        return;
    };

    state.hub.send_to(
        &to,
        &ServerEvent::Message {
            message: message.clone(),
        },
    );
    // Echo to the sender's other devices, and acknowledge on this one.
    state.hub.send_to_others(
        user_id,
        socket_id,
        &ServerEvent::Message {
            message: message.clone(),
        },
    );
    state
        .hub
        .send_to_socket(user_id, socket_id, &ServerEvent::Ack { client_id, message });
}
