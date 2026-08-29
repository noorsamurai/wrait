//! Running the office as a Windows service.
//!
//! Failover already covers the ordinary case: when the computer hosting the
//! office is switched off, another one takes over. But a machine that is meant
//! to be the office's home - the one in the back room that nobody logs into -
//! should not need anybody signed in at all, and an application only runs
//! while its user's session does.
//!
//! So the same exe can register itself with Windows and run the relay with no
//! window, no webview and no signed-in user. It is opt-in and needs
//! administrator rights, because the portable exe's whole promise is that it
//! installs nothing unless asked.
//!
//!   lokalen.exe --install-service     (as administrator)
//!   lokalen.exe --uninstall-service   (as administrator)
//!
//! `--service` is what Windows itself calls; nobody types it.

use std::ffi::OsString;
use std::time::Duration;

use windows_service::service::{
    ServiceAccess, ServiceControl, ServiceControlAccept, ServiceErrorControl, ServiceExitCode,
    ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

const NAME: &str = "Lokalen";
const DISPLAY: &str = "Lokalen - kontorets meddelanden";
const DESCRIPTION: &str =
    "Håller kontorets meddelanden igång även när ingen är inloggad på den här datorn.";

/// Interprets the service flags, if any. Returns true when the flag was
/// handled and the app should not open a window.
pub fn handle_arguments() -> bool {
    let args: Vec<String> = std::env::args().collect();
    let has = |flag: &str| args.iter().any(|a| a == flag);

    if has("--service") {
        // Windows starts the process itself; this hands control to it.
        if let Err(err) = service_dispatcher::start(NAME, ffi_service_main) {
            eprintln!("Kunde inte starta tjänsten: {err}");
        }
        return true;
    }
    if has("--install-service") {
        report(install());
        return true;
    }
    if has("--uninstall-service") {
        report(uninstall());
        return true;
    }
    false
}

fn report(result: Result<String, String>) {
    match result {
        Ok(message) => println!("{message}"),
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}

fn manager(access: ServiceManagerAccess) -> Result<ServiceManager, String> {
    ServiceManager::local_computer(None::<&str>, access).map_err(|err| {
        format!(
            "Kunde inte nå Windows tjänsthanterare ({err}).\n\
             Kör kommandot från en kommandotolk som administratör."
        )
    })
}

fn install() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let manager = manager(ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)?;

    let service = manager
        .create_service(
            &ServiceInfo {
                name: OsString::from(NAME),
                display_name: OsString::from(DISPLAY),
                service_type: ServiceType::OWN_PROCESS,
                start_type: ServiceStartType::AutoStart,
                error_control: ServiceErrorControl::Normal,
                executable_path: exe.clone(),
                launch_arguments: vec![OsString::from("--service")],
                dependencies: vec![],
                // The local system account: the relay writes only beside its
                // own exe and needs nothing from anyone's profile.
                account_name: None,
                account_password: None,
            },
            ServiceAccess::CHANGE_CONFIG | ServiceAccess::START,
        )
        .map_err(|err| format!("Kunde inte registrera tjänsten: {err}"))?;

    let _ = service.set_description(DESCRIPTION);
    service
        .start(&[] as &[&std::ffi::OsStr])
        .map_err(|err| format!("Tjänsten registrerades men startade inte: {err}"))?;

    Ok(format!(
        "Lokalen körs nu som en tjänst från {}.\n\
         Kontoret är igång så snart datorn startar, utan att någon loggar in.",
        exe.display()
    ))
}

fn uninstall() -> Result<String, String> {
    let manager = manager(ServiceManagerAccess::CONNECT)?;
    let service = manager
        .open_service(NAME, ServiceAccess::STOP | ServiceAccess::DELETE | ServiceAccess::QUERY_STATUS)
        .map_err(|err| format!("Hittade ingen installerad tjänst: {err}"))?;

    // Stopping a service that is already stopped is an error worth ignoring.
    let _ = service.stop();
    service
        .delete()
        .map_err(|err| format!("Kunde inte ta bort tjänsten: {err}"))?;

    Ok("Tjänsten är borttagen. Appen fungerar som vanligt utan den.".into())
}

define_windows_service!(ffi_service_main, service_main);

fn service_main(_arguments: Vec<OsString>) {
    if let Err(err) = run_service() {
        eprintln!("[tjänst] {err}");
    }
}

fn run_service() -> Result<(), Box<dyn std::error::Error>> {
    let (stop_tx, stop_rx) = std::sync::mpsc::channel();

    let status_handle = service_control_handler::register(NAME, move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            let _ = stop_tx.send(());
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })?;

    let running = |state: ServiceState, accept: ServiceControlAccept| ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: accept,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    };

    status_handle.set_service_status(running(
        ServiceState::Running,
        ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
    ))?;

    let runtime = tokio::runtime::Runtime::new()?;
    let relay = runtime.block_on(async {
        crate::relay::start(
            8787,
            &crate::portable::relay_dir(),
            crate::relay::model::OfficeMode::Open,
            "Lokalen",
        )
        .await
    });

    match relay {
        Err(err) => eprintln!("[tjänst] kunde inte starta kontoret: {err}"),
        Ok(relay) => {
            // Blocks until Windows asks the service to stop.
            let _ = stop_rx.recv();
            runtime.block_on(relay.stop());
        }
    }

    status_handle.set_service_status(running(
        ServiceState::Stopped,
        ServiceControlAccept::empty(),
    ))?;
    Ok(())
}
