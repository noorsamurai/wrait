//! Surviving a computer going away.
//!
//! The point of replication is one thing only: that a machine which was not
//! hosting can start hosting, with the office intact, using the credentials
//! people already have. So this drives a real relay over a real socket, has a
//! second machine follow it, switches the first one off, and then asks the
//! second one for the history and the attachments as if nothing had happened.

use std::path::{Path, PathBuf};
use std::time::Duration;

use lokalen_lib::relay::discovery::{defers_to, Candidate};
use lokalen_lib::relay::model::OfficeMode;
use lokalen_lib::relay::replica::Replica;
use lokalen_lib::relay::{files, store};

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "lokalen-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        Self(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn join(url: &str, name: &str) -> (String, String) {
    let response = reqwest::Client::new()
        .post(format!("{url}/api/join"))
        .json(&serde_json::json!({ "displayName": name }))
        .send()
        .await
        .expect("join");
    let body: serde_json::Value = response.json().await.expect("join body");
    (
        body["token"].as_str().expect("token").to_string(),
        body["user"]["id"].as_str().expect("id").to_string(),
    )
}

async fn history(url: &str, token: &str) -> serde_json::Value {
    reqwest::Client::new()
        .get(format!("{url}/api/directory"))
        .bearer_auth(token)
        .send()
        .await
        .expect("directory")
        .json()
        .await
        .expect("directory body")
}

#[tokio::test]
async fn a_standby_takes_over_with_the_office_intact() {
    let host_dir = TempDir::new("host");
    let standby_dir = TempDir::new("standby");

    let host = lokalen_lib::relay::start(0, host_dir.path(), OfficeMode::Open, "Kliniken")
        .await
        .expect("host starts");
    let host_url = format!("http://127.0.0.1:{}", host.info.port);

    // Two rooms sign in, and one writes to the other.
    let (anna_token, anna_id) = join(&host_url, "Behandlingsrum 1").await;
    let (_bjorn_token, bjorn_id) = join(&host_url, "Reception").await;
    store::insert_message(
        &host.db,
        None,
        &anna_id,
        &bjorn_id,
        "Patienten är klar",
        false,
        None,
    )
    .expect("message stored");

    // An attachment, because the bytes live outside the database and are the
    // part most easily forgotten.
    let blob = b"remiss".to_vec();
    let file_id = files::init_upload(
        &host.db,
        host_dir.path(),
        &anna_id,
        "remiss.txt",
        blob.len() as i64,
        "text/plain",
        &bjorn_id,
    )
    .expect("upload starts");
    let row = files::get(&host.db, &file_id).expect("file row");
    files::write_chunk(&host.db, host_dir.path(), &row, 0, &blob).expect("chunk written");

    // A second machine follows along.
    let standby_db =
        store::open(Some(&standby_dir.path().join("lokalen.db"))).expect("standby db");
    let replica = Replica::new(&host_url, &anna_token, standby_db.clone(), standby_dir.path());

    let info = replica.info().await.expect("host info");
    assert_eq!(info.term, 1, "the first host is serving the first round");

    replica.take_snapshot().await.expect("snapshot");
    replica.follow(0).await.expect("tail");
    replica.backfill_blobs(50).await;

    assert_eq!(
        replica.watermark(),
        lokalen_lib::relay::oplog::watermark(&host.db.lock().unwrap()),
        "the standby has caught up with the host"
    );

    // Something written after the snapshot must arrive over the tail.
    store::insert_message(&host.db, None, &bjorn_id, &anna_id, "Tack!", false, None)
        .expect("second message");
    replica.follow(0).await.expect("tail again");

    // The hosting computer is switched off.
    host.stop().await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    // The standby starts serving what it has been keeping all along.
    let promoted = lokalen_lib::relay::start_with(
        standby_db.clone(),
        0,
        standby_dir.path(),
        OfficeMode::Open,
        "Kliniken",
        2,
    )
    .await
    .expect("standby takes over");
    let new_url = format!("http://127.0.0.1:{}", promoted.info.port);

    // The same session still works: nobody has to sign in again.
    let directory = history(&new_url, &anna_token).await;
    let names: Vec<&str> = directory["users"]
        .as_array()
        .expect("users")
        .iter()
        .filter_map(|u| u["displayName"].as_str())
        .collect();
    assert!(names.contains(&"Behandlingsrum 1"), "rooms survived: {names:?}");
    assert!(names.contains(&"Reception"), "rooms survived: {names:?}");

    // Both messages are there, including the one that only ever arrived over
    // the tail.
    let messages = store::recent_history(&standby_db, &anna_id, 100);
    let bodies: Vec<&str> = messages.iter().map(|m| m.body.as_str()).collect();
    assert!(bodies.contains(&"Patienten är klar"), "history: {bodies:?}");
    assert!(bodies.contains(&"Tack!"), "history: {bodies:?}");

    // And so is the attachment, byte for byte.
    let row = files::get(&standby_db, &file_id).expect("file row on the standby");
    assert!(row.complete, "the file is marked complete");
    let bytes = files::read_blob(standby_dir.path(), &row).expect("blob on the standby");
    assert_eq!(bytes, blob, "the attachment came across");

    // The office kept its identity, so the machines still know it is theirs.
    assert_eq!(
        store::office_id(&standby_db),
        info.office,
        "the office id travelled with the copy"
    );

    promoted.stop().await;
}

#[tokio::test]
async fn the_most_complete_copy_wins_an_election() {
    let behind = Candidate { term: 2, watermark: 40, instance: "a".into() };
    let ahead = Candidate { term: 2, watermark: 90, instance: "b".into() };
    assert!(defers_to(&behind, &ahead), "more history wins");
    assert!(!defers_to(&ahead, &behind));

    // A later round beats more history: it means somebody has already served
    // that round, and rejoining it loses less than splitting the office.
    let older = Candidate { term: 2, watermark: 900, instance: "a".into() };
    let newer = Candidate { term: 3, watermark: 10, instance: "b".into() };
    assert!(defers_to(&older, &newer));

    // Two identical copies still have to agree, and both must agree the same
    // way round or they would both stand down.
    let one = Candidate { term: 2, watermark: 40, instance: "aaa".into() };
    let two = Candidate { term: 2, watermark: 40, instance: "bbb".into() };
    assert!(defers_to(&one, &two));
    assert!(!defers_to(&two, &one));
}


#[tokio::test]
async fn a_backup_carries_the_whole_office_including_its_attachments() {
    let dir = TempDir::new("backup");
    let restored_dir = TempDir::new("restored");

    let db = store::open(Some(&dir.path().join("lokalen.db"))).expect("db");
    store::init_office(&db, OfficeMode::Open, "Kliniken");
    store::seed_rooms(&db);

    let anna = store::create_guest(&db, "Behandlingsrum 1").expect("anna");
    let reception = store::create_guest(&db, "Reception").expect("reception");
    store::insert_message(&db, None, &anna, &reception, "Röntgen klar", false, None)
        .expect("message");

    // An attachment big enough to be split across several rows in the backup,
    // which is the case a single blob column would have failed on.
    let blob = vec![7u8; 9 * 1024 * 1024];
    let file_id = files::init_upload(
        &db,
        dir.path(),
        &anna,
        "rontgen.raw",
        blob.len() as i64,
        "application/octet-stream",
        &reception,
    )
    .expect("upload starts");
    let row = files::get(&db, &file_id).expect("file row");
    for (index, piece) in blob.chunks(512 * 1024).enumerate() {
        files::write_chunk(&db, dir.path(), &row, index as i64, piece).expect("chunk");
    }

    let archive = dir.path().join("kliniken.lokalen");
    let written = lokalen_lib::relay::backup::export(&db, dir.path(), &archive).expect("export");
    assert!(written.messages >= 1, "the backup counted the messages");
    assert_eq!(written.files, 1, "and the attachment");
    assert_eq!(written.bytes, blob.len() as i64);

    // A different machine, with nothing on it, restores the file.
    let fresh = store::open(Some(&restored_dir.path().join("lokalen.db"))).expect("fresh db");
    let read = lokalen_lib::relay::backup::import(&fresh, restored_dir.path(), &archive)
        .expect("import");
    assert_eq!(read.files, 1);

    let messages = store::recent_history(&fresh, &anna, 50);
    let bodies: Vec<&str> = messages.iter().map(|m| m.body.as_str()).collect();
    assert!(bodies.contains(&"Röntgen klar"), "history restored: {bodies:?}");

    let row = files::get(&fresh, &file_id).expect("file row restored");
    let bytes = files::read_blob(restored_dir.path(), &row).expect("blob restored");
    assert_eq!(bytes, blob, "the attachment came back byte for byte");

    // The restored copy is a working office, not just a readable file.
    assert_eq!(store::office_info(&fresh).name, "Kliniken");
}

#[tokio::test]
async fn a_file_that_is_not_a_backup_is_refused() {
    let dir = TempDir::new("notabackup");
    let db = store::open(Some(&dir.path().join("lokalen.db"))).expect("db");
    store::init_office(&db, OfficeMode::Open, "Kliniken");

    let bogus = dir.path().join("semester.jpg");
    std::fs::write(&bogus, b"inte en databas").expect("write");

    let error = lokalen_lib::relay::backup::import(&db, dir.path(), &bogus)
        .expect_err("a photo is not an office");
    assert!(error.contains("säkerhetskopia"), "said so plainly: {error}");

    // And the office it refused to replace is still there.
    assert_eq!(store::office_info(&db).name, "Kliniken");
}
