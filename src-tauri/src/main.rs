// Prevents an extra console window on Windows in release. macOS is the primary
// target, but this is harmless and conventional.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::async_runtime::Receiver;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const BACKEND_HOST: &str = "127.0.0.1";
const BACKEND_PORT: u16 = 8000;
const FRONTEND_HOST: &str = "127.0.0.1";
const FRONTEND_PORT: u16 = 3000;
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(300);

/// Live child processes, killed when the app exits so no orphan uvicorn/node
/// survives.
#[derive(Default)]
struct Sidecars(Mutex<Vec<CommandChild>>);

/// Drain a sidecar's event stream into a log file so a crash that would
/// otherwise be invisible (the receiver was previously dropped) leaves a
/// diagnosable trail. Stdout/stderr lines are appended verbatim; process
/// errors and termination are tagged so an unexpected exit is obvious.
fn pump_sidecar_log(mut rx: Receiver<CommandEvent>, log_path: PathBuf, tag: &'static str) {
    tauri::async_runtime::spawn(async move {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok();
        while let Some(event) = rx.recv().await {
            let entry: Option<Vec<u8>> = match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => Some(bytes),
                CommandEvent::Error(err) => {
                    Some(format!("[{tag}] process error: {err}\n").into_bytes())
                }
                CommandEvent::Terminated(payload) => Some(
                    format!(
                        "[{tag}] terminated: code={:?} signal={:?}\n",
                        payload.code, payload.signal
                    )
                    .into_bytes(),
                ),
                _ => None,
            };
            if let (Some(bytes), Some(f)) = (entry, file.as_mut()) {
                let _ = f.write_all(&bytes);
                if !bytes.ends_with(b"\n") {
                    let _ = f.write_all(b"\n");
                }
                let _ = f.flush();
            }
        }
    });
}

fn tcp_ready(host: &str, port: u16) -> bool {
    TcpStream::connect((host, port)).is_ok()
}

/// Block until `host:port` accepts a connection or the timeout elapses.
fn wait_until_ready(host: &str, port: u16, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if tcp_ready(host, port) {
            return true;
        }
        std::thread::sleep(READY_POLL_INTERVAL);
    }
    false
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecars::default())
        .setup(|app| {
            let handle = app.handle().clone();

            // Canonical config location shared with the CLI/dev backend (Phase 1
            // default). The backend reads BOWTIE_CONFIG_DIR; setting it here makes
            // the packaged app and the CLI agree on one config file.
            let config_dir = handle
                .path()
                .home_dir()?
                .join("Library/Application Support/BowtieContentTool");
            std::fs::create_dir_all(&config_dir)?;

            // Capture sidecar output here so a silent crash (e.g. the backend
            // failing to bind the port) is diagnosable after the fact.
            let log_dir = config_dir.join("logs");
            std::fs::create_dir_all(&log_dir)?;

            // --- Backend sidecar: the PyInstaller `content-tool-api` binary. ---
            // Pass our PID so the backend's supervisor watchdog can self-exit if
            // the bootloader is killed and the frozen child is orphaned (see
            // content_tool/desktop/server_entry.py) — kill() alone reaps only the
            // bootloader, not its forked child.
            let (backend_rx, backend_child) = handle
                .shell()
                .sidecar("content-tool-api")?
                .env("CONTENT_TOOL_HOST", BACKEND_HOST)
                .env("CONTENT_TOOL_PORT", BACKEND_PORT.to_string())
                .env("BOWTIE_CONFIG_DIR", config_dir.to_string_lossy().to_string())
                .env("BOWTIE_SUPERVISOR_PID", std::process::id().to_string())
                .spawn()?;
            pump_sidecar_log(backend_rx, log_dir.join("backend.log"), "backend");

            // --- Frontend sidecar: bundled Node running the Next standalone server. ---
            let frontend_dir = handle
                .path()
                .resource_dir()?
                .join("resources/frontend");
            let node_bin = frontend_dir.join("node");
            let (frontend_rx, frontend_child) = handle
                .shell()
                .command(node_bin.to_string_lossy().to_string())
                .args(["server.js"])
                .current_dir(frontend_dir)
                .env("PORT", FRONTEND_PORT.to_string())
                .env("HOSTNAME", FRONTEND_HOST)
                .spawn()?;
            pump_sidecar_log(frontend_rx, log_dir.join("frontend.log"), "frontend");

            {
                let sidecars = app.state::<Sidecars>();
                let mut guard = sidecars.0.lock().unwrap();
                guard.push(backend_child);
                guard.push(frontend_child);
            }

            // Wait for the frontend to come up, then point the window at it and
            // reveal it (avoids a flash of connection-refused).
            std::thread::spawn(move || {
                let ready = wait_until_ready(FRONTEND_HOST, FRONTEND_PORT, READY_TIMEOUT);
                if let Some(window) = handle.get_webview_window("main") {
                    if ready {
                        let url = format!("http://{FRONTEND_HOST}:{FRONTEND_PORT}/");
                        if let Ok(parsed) = url.parse() {
                            let _ = window.navigate(parsed);
                        }
                    }
                    let _ = window.show();
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Bowtie Content Tool")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                // Best-effort cleanup: kill both sidecars on shutdown.
                let sidecars = app_handle.state::<Sidecars>();
                // Collect the children out under the lock, then kill after the
                // guard is dropped — avoids holding the mutex across kill() and
                // keeps the lock temporary from outliving `sidecars`.
                let children: Vec<CommandChild> = match sidecars.0.lock() {
                    Ok(mut guard) => guard.drain(..).collect(),
                    Err(_) => Vec::new(),
                };
                for child in children {
                    let _ = child.kill();
                }
            }
        });
}
