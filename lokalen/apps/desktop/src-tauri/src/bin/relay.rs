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

    let mode = if flag("--mode").or_else(|| std::env::var("OFFICE_MODE").ok()).as_deref()
        == Some("password")
    {
        lokalen_lib::relay::model::OfficeMode::Password
    } else {
        lokalen_lib::relay::model::OfficeMode::Open
    };
    let office_name = flag("--name")
        .or_else(|| std::env::var("OFFICE_NAME").ok())
        .unwrap_or_else(|| "Lokalen".to_string());

    match lokalen_lib::relay::start(port, &data_dir, mode, &office_name).await {
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
        Ok(relay) => {
            println!("Lokalen-relä lyssnar på port {}", relay.info.port);
            println!(
                "  kontor:  {} ({})",
                relay.info.name,
                if relay.info.mode == "open" { "öppet - bara namn" } else { "kräver konto" }
            );
            println!("  data:    {}", data_dir.display());
            for address in &relay.info.addresses {
                println!("  anslut till:  {address}");
            }
            // Run until interrupted.
            let _ = tokio::signal::ctrl_c().await;
            relay.stop().await;
        }
    }
}
