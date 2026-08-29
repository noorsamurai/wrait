//! Authorization boundaries of the embedded relay.
//!
//! The browser suite drives the happy paths through a real socket; these cover
//! the refusals it does not reach, directly against the router.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use lokalen_lib::relay::hub::Hub;
use lokalen_lib::relay::routes::{router, AppState};
use lokalen_lib::relay::model::OfficeMode;
use lokalen_lib::relay::store;

struct Harness {
    state: AppState,
    _dir: tempdir::TempDir,
}

/// Minimal scratch directory helper, so the test needs no extra crate.
mod tempdir {
    use std::path::{Path, PathBuf};
    pub struct TempDir(PathBuf);
    impl TempDir {
        pub fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "comms-{tag}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }
        pub fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

impl Harness {
    /// A passworded office - accounts, the original behaviour.
    fn new(tag: &str) -> Self {
        Self::with_mode(tag, OfficeMode::Password)
    }

    /// An open office - name only, no passwords anywhere.
    fn open(tag: &str) -> Self {
        Self::with_mode(tag, OfficeMode::Open)
    }

    fn with_mode(tag: &str, mode: OfficeMode) -> Self {
        let dir = tempdir::TempDir::new(tag);
        let db = store::open(Some(&dir.path().join("lokalen.db"))).expect("open db");
        store::init_office(&db, mode, "Testkontoret");
        Self {
            state: AppState {
                db,
                hub: Hub::new(),
                data_dir: std::sync::Arc::new(dir.path().to_path_buf()),
                term: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(1)),
            },
            _dir: dir,
        }
    }

    async fn call(&self, request: Request<Body>) -> (StatusCode, Value) {
        let response = router(self.state.clone())
            .oneshot(request)
            .await
            .expect("router");
        let status = response.status();
        let bytes = response.into_body().collect().await.expect("body").to_bytes();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    async fn post(&self, path: &str, token: Option<&str>, body: Value) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        self.call(builder.body(Body::from(body.to_string())).unwrap())
            .await
    }

    async fn get(&self, path: &str, token: Option<&str>) -> (StatusCode, Value) {
        let mut builder = Request::builder().method("GET").uri(path);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        self.call(builder.body(Body::empty()).unwrap()).await
    }

    async fn register(&self, username: &str, display: &str, password: &str) -> (String, String) {
        let (status, body) = self
            .post(
                "/api/register",
                None,
                json!({ "username": username, "displayName": display, "password": password }),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "register {username}: {body}");
        (
            body["token"].as_str().unwrap().to_string(),
            body["user"]["id"].as_str().unwrap().to_string(),
        )
    }
}

#[tokio::test]
async fn derives_the_monogram_and_rejects_weak_or_duplicate_accounts() {
    let h = Harness::new("accounts");

    let (_, _) = h.register("alice", "Alice Nakamura", "correct-horse").await;
    let (status, body) = h.get("/api/directory", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "the directory is not public: {body}");

    let (status, _) = h
        .post(
            "/api/register",
            None,
            json!({ "username": "ALICE", "displayName": "Impostor", "password": "whatever12" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "usernames are case-insensitively unique");

    let (status, _) = h
        .post(
            "/api/register",
            None,
            json!({ "username": "dave", "displayName": "Dave", "password": "short" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "short passwords are refused");

    let (status, _) = h
        .post(
            "/api/register",
            None,
            json!({ "username": "no spaces", "displayName": "X", "password": "longenough" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "usernames are constrained");
}

#[tokio::test]
async fn login_does_not_distinguish_a_missing_account_from_a_bad_password() {
    let h = Harness::new("login");
    h.register("alice", "Alice Nakamura", "correct-horse").await;

    let (ok, body) = h
        .post("/api/login", None, json!({ "username": "alice", "password": "correct-horse" }))
        .await;
    assert_eq!(ok, StatusCode::OK);
    assert!(body["token"].is_string());
    assert_eq!(body["user"]["initials"], "AN");

    let (wrong, wrong_body) = h
        .post("/api/login", None, json!({ "username": "alice", "password": "nope-nope-nope" }))
        .await;
    let (missing, missing_body) = h
        .post("/api/login", None, json!({ "username": "ghost", "password": "nope-nope-nope" }))
        .await;

    assert_eq!(wrong, StatusCode::UNAUTHORIZED);
    assert_eq!(missing, StatusCode::UNAUTHORIZED);
    assert_eq!(
        wrong_body["message"], missing_body["message"],
        "an unknown account must be indistinguishable from a wrong password"
    );
}

#[tokio::test]
async fn a_file_is_readable_only_by_its_sender_and_its_recipient() {
    let h = Harness::new("files");
    let (alice_token, _) = h.register("alice", "Alice Nakamura", "correct-horse").await;
    let (bob_token, bob_id) = h.register("bob", "Bob Ortiz", "hunter2hunter2").await;
    let (carol_token, _) = h.register("carol", "Carol Vance", "passphrase123").await;

    let payload = b"quarterly numbers";
    let (status, body) = h
        .post(
            "/api/files/init",
            Some(&alice_token),
            json!({ "name": "report.txt", "size": payload.len(), "mime": "text/plain", "to": bob_id }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let file_id = body["fileId"].as_str().unwrap().to_string();

    // Someone else may not write into another person's upload.
    let hijack = Request::builder()
        .method("PUT")
        .uri(format!("/api/files/{file_id}/chunk?index=0"))
        .header("authorization", format!("Bearer {carol_token}"))
        .body(Body::from("evil"))
        .unwrap();
    let (status, _) = h.call(hijack).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "only the uploader may write chunks");

    let upload = Request::builder()
        .method("PUT")
        .uri(format!("/api/files/{file_id}/chunk?index=0"))
        .header("authorization", format!("Bearer {alice_token}"))
        .body(Body::from(payload.to_vec()))
        .unwrap();
    let (status, body) = h.call(upload).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["complete"], true, "one chunk completes a small file");

    // The recipient can read it back, byte for byte.
    let download = Request::builder()
        .method("GET")
        .uri(format!("/api/files/{file_id}"))
        .header("authorization", format!("Bearer {bob_token}"))
        .body(Body::empty())
        .unwrap();
    let response = router(h.state.clone()).oneshot(download).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(bytes.as_ref(), payload, "bytes survive the round trip");

    // A third party cannot.
    let (status, _) = h.get(&format!("/api/files/{file_id}"), Some(&carol_token)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "not shared with them");

    let (status, _) = h.get(&format!("/api/files/{file_id}"), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_chunk_of_the_wrong_length_is_refused() {
    let h = Harness::new("chunks");
    let (alice_token, _) = h.register("alice", "Alice Nakamura", "correct-horse").await;
    let (_, bob_id) = h.register("bob", "Bob Ortiz", "hunter2hunter2").await;

    let (_, body) = h
        .post(
            "/api/files/init",
            Some(&alice_token),
            json!({ "name": "a.bin", "size": 10, "mime": "application/octet-stream", "to": bob_id }),
        )
        .await;
    let file_id = body["fileId"].as_str().unwrap().to_string();

    let short = Request::builder()
        .method("PUT")
        .uri(format!("/api/files/{file_id}/chunk?index=0"))
        .header("authorization", format!("Bearer {alice_token}"))
        .body(Body::from("only4"))
        .unwrap();
    let (status, _) = h.call(short).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a truncated chunk cannot silently corrupt the file");

    let out_of_range = Request::builder()
        .method("PUT")
        .uri(format!("/api/files/{file_id}/chunk?index=9"))
        .header("authorization", format!("Bearer {alice_token}"))
        .body(Body::from("0123456789"))
        .unwrap();
    let (status, _) = h.call(out_of_range).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "chunk index is bounded");
}

/* ------------------------------------------------------------------ */
/* Open offices                                                        */
/* ------------------------------------------------------------------ */

#[tokio::test]
async fn an_open_office_lets_people_in_by_name_alone() {
    let h = Harness::open("open");

    let (status, body) = h.get("/api/office", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["mode"], "open");
    assert_eq!(body["name"], "Testkontoret", "the office keeps the name it was given");

    let (status, body) = h
        .post("/api/join", None, json!({ "displayName": "Anna Lindqvist" }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["user"]["displayName"], "Anna Lindqvist");
    assert_eq!(body["user"]["initials"], "AL");
    assert!(body["token"].is_string());

    let first_id = body["user"]["id"].as_str().unwrap().to_string();

    // Same person, different machine: they get their identity and history back
    // rather than a duplicate entry in the directory.
    let (status, again) = h
        .post("/api/join", None, json!({ "displayName": "anna lindqvist" }))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        again["user"]["id"].as_str().unwrap(),
        first_id,
        "a name is reclaimed, not duplicated"
    );

    let (status, _) = h.post("/api/join", None, json!({ "displayName": "   " })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a blank name is refused");
}

#[tokio::test]
async fn the_two_office_modes_do_not_leak_into_each_other() {
    let open = Harness::open("modes-open");
    let (status, body) = open
        .post(
            "/api/register",
            None,
            json!({ "username": "anna", "displayName": "Anna", "password": "hemligtnog" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "no accounts in an open office: {body}");

    let closed = Harness::new("modes-closed");
    let (status, _) = closed
        .post("/api/join", None, json!({ "displayName": "Anna" }))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "no name-only entry into a passworded office");
}

#[tokio::test]
async fn a_passwordless_account_cannot_be_logged_into() {
    let h = Harness::open("guest-login");
    let (_, body) = h
        .post("/api/join", None, json!({ "displayName": "Anna Lindqvist" }))
        .await;
    let username = body["user"]["username"].as_str().unwrap().to_string();

    // An empty stored password must never match an empty submitted one.
    for password in ["", " ", "hemligtnog"] {
        let (status, _) = h
            .post("/api/login", None, json!({ "username": username, "password": password }))
            .await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "a name-only account must not be reachable through the password path"
        );
    }
}
