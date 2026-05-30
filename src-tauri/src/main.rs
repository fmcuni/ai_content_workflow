// Prevents an extra console window on Windows in release. macOS is the primary
// target, but this is harmless and conventional.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;
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

            // --- Backend sidecar: the PyInstaller `content-tool-api` binary. ---
            let (_backend_rx, backend_child) = handle
                .shell()
                .sidecar("content-tool-api")?
                .env("CONTENT_TOOL_HOST", BACKEND_HOST)
                .env("CONTENT_TOOL_PORT", BACKEND_PORT.to_string())
                .env("BOWTIE_CONFIG_DIR", config_dir.to_string_lossy().to_string())
                .spawn()?;

            // --- Frontend sidecar: bundled Node running the Next standalone server. ---
            let frontend_dir = handle
                .path()
                .resource_dir()?
                .join("resources/frontend");
            let node_bin = frontend_dir.join("node");
            let (_frontend_rx, frontend_child) = handle
                .shell()
                .command(node_bin.to_string_lossy().to_string())
                .args(["server.js"])
                .current_dir(frontend_dir)
                .env("PORT", FRONTEND_PORT.to_string())
                .env("HOSTNAME", FRONTEND_HOST)
                .spawn()?;

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
                if let Ok(mut guard) = sidecars.0.lock() {
                    for child in guard.drain(..) {
                        let _ = child.kill();
                    }
                }
            }
        });
}
