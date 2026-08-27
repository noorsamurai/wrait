//! Discovery over a real socket.

use std::time::Duration;
use wrait_comms_lib::relay::discovery;

/// One test rather than two: the beacon binds a fixed well-known port, so a
/// pair of tests running concurrently would each see the other's announcements.
/// Doing it in sequence also proves that stopping actually stops.
#[tokio::test]
async fn an_office_is_discoverable_while_hosted_and_not_after() {
    let Some(beacon) = discovery::announce(8787, "test-office".into()) else {
        // A sandbox with no multicast- or broadcast-capable interface cannot
        // exercise this; skip rather than fail on network policy.
        eprintln!("skipped: could not bind the discovery port");
        return;
    };

    let found = discovery::discover(Duration::from_millis(900)).await;
    let office = found
        .iter()
        .find(|o| o.id == "test-office")
        .unwrap_or_else(|| panic!("the beacon should answer its own probe; found {found:?}"));

    assert!(
        office.url.ends_with(":8787"),
        "the advertised relay port should be the one dialled: {}",
        office.url
    );
    assert!(!office.name.is_empty(), "the host machine should be named");
    assert!(
        office.url.starts_with("http://"),
        "the url should paste straight into the server field: {}",
        office.url
    );

    beacon.stop();
    // Let the aborted task's socket close before probing again.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let after = discovery::discover(Duration::from_millis(600)).await;
    assert!(
        after.iter().all(|o| o.id != "test-office"),
        "a stopped beacon must stop answering: {after:?}"
    );
}
