//! Headless relay.
//!
//! The same relay the app hosts in-process, as a standalone binary. Useful for
//! an always-on office machine that should not run a GUI, and it is what the
//! integration tests drive.
//!
//!   relay [--port 8787] [--data ./comms-data]

use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str| -> Option<String> {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };

    let port: u16 = flag("--port")
        .or_else(|| std::env::var("PORT").ok())
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);

    let data_dir = PathBuf::from(
        flag("--data")
            .or_else(|| std::env::var("COMMS_DATA").ok())
            .unwrap_or_else(|| "./comms-data".to_string()),
    );

    match wrait_comms_lib::relay::start(port, &data_dir).await {
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
        Ok(relay) => {
            println!("Wrait Comms relay listening on port {}", relay.info.port);
            println!("  data:  {}", data_dir.display());
            for address in &relay.info.addresses {
                println!("  point clients at:  {address}");
            }
            // Run until interrupted.
            let _ = tokio::signal::ctrl_c().await;
            relay.stop().await;
        }
    }
}
