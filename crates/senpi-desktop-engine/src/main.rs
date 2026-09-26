//! `senpi-desktop-engine`: the standalone desktop engine. JSON-RPC 2.0 over
//! NDJSON on stdio (default) or a local socket; `--selftest` and `--schema`
//! for locators and drift gates.

mod client;
mod config;
mod connection;
mod daemon;
mod engine;
mod fake_listener;
mod oneshot;
mod outbox;
mod route;
mod rpc;
mod selftest;
mod serve;
mod stop_path;

use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use clap::{ArgGroup, Parser};

use crate::config::EngineConfig;
use crate::engine::Engine;

#[derive(Debug, Parser)]
#[command(
    name = "senpi-desktop-engine",
    version,
    about = "Senpi desktop engine (JSON-RPC 2.0 over NDJSON)"
)]
#[command(group(ArgGroup::new("mode").args(["stdio", "serve", "oneshot", "resume", "selftest", "schema"])))]
struct Cli {
    /// Serve on stdin/stdout (the default).
    #[arg(long)]
    stdio: bool,
    /// Serve on a unix socket path or `\\.\pipe\<name>`, one client at a time.
    #[arg(long, value_name = "ENDPOINT")]
    serve: Option<String>,
    /// With --serve (or a daemon --oneshot starts): exit after this long without a client.
    #[arg(long, value_name = "MS", default_value_t = 300_000)]
    idle_ms: u64,
    /// Forward one request line to the --serve daemon (bunshin sidecar contract).
    #[arg(long)]
    oneshot: bool,
    /// Lift a stop latched in the daemon (the desktop user's reset).
    #[arg(long)]
    resume: bool,
    /// Daemon endpoint for --oneshot / --resume (default: the per-user socket).
    #[arg(long, value_name = "ENDPOINT")]
    endpoint: Option<String>,
    #[command(flatten)]
    daemon: DaemonArgs,
    /// Drive a built-in fake session and print `engine: selftest ok`.
    #[arg(long)]
    selftest: bool,
    /// Print the engine protocol JSON Schema.
    #[arg(long)]
    schema: bool,
}

/// The daemon session's options (`--serve`, and `--oneshot` passes them on
/// when it starts the daemon).
#[derive(Debug, clap::Args)]
struct DaemonArgs {
    #[arg(long, value_name = "PATH")]
    audit_path: Option<std::path::PathBuf>,
    #[arg(long, value_name = "DIR")]
    artifact_dir: Option<std::path::PathBuf>,
    #[arg(long)]
    max_width: Option<u32>,
    #[arg(long)]
    max_height: Option<u32>,
    #[arg(long)]
    max_bytes: Option<u64>,
    #[arg(long)]
    display: Option<String>,
    #[arg(long, value_name = "CHORD")]
    stop_chord: Option<String>,
    #[arg(long)]
    allow_host_relay_only_stop: bool,
}

impl DaemonArgs {
    fn options(&self) -> daemon::DaemonOptions {
        daemon::DaemonOptions {
            audit_path: self.audit_path.clone(),
            artifact_dir: self.artifact_dir.clone(),
            max_width: self.max_width,
            max_height: self.max_height,
            max_bytes: self.max_bytes,
            display: self.display.clone(),
            stop_chord: self.stop_chord.clone(),
            allow_host_relay_only_stop: self.allow_host_relay_only_stop,
        }
    }

    /// The same options as `--serve` flags, for an auto-started daemon.
    fn serve_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        let mut push = |flag: &str, value: Option<String>| {
            if let Some(value) = value {
                args.extend([flag.to_owned(), value]);
            }
        };
        push(
            "--audit-path",
            self.audit_path.as_ref().map(|path| path.display().to_string()),
        );
        push(
            "--artifact-dir",
            self.artifact_dir.as_ref().map(|path| path.display().to_string()),
        );
        push("--max-width", self.max_width.map(|value| value.to_string()));
        push("--max-height", self.max_height.map(|value| value.to_string()));
        push("--max-bytes", self.max_bytes.map(|value| value.to_string()));
        push("--display", self.display.clone());
        push("--stop-chord", self.stop_chord.clone());
        if self.allow_host_relay_only_stop {
            args.push("--allow-host-relay-only-stop".to_owned());
        }
        args
    }
}

enum Mode {
    Stdio,
    Serve {
        endpoint: String,
        idle: Duration,
        daemon: daemon::DaemonOptions,
    },
    Oneshot {
        endpoint: Option<String>,
        serve_args: Vec<String>,
    },
    Resume {
        endpoint: Option<String>,
    },
    Selftest,
    Schema,
}

impl Cli {
    fn mode(self) -> Mode {
        if let Some(endpoint) = self.serve {
            Mode::Serve {
                endpoint,
                idle: Duration::from_millis(self.idle_ms),
                daemon: self.daemon.options(),
            }
        } else if self.oneshot {
            Mode::Oneshot {
                endpoint: self.endpoint,
                serve_args: [
                    vec!["--idle-ms".to_owned(), self.idle_ms.to_string()],
                    self.daemon.serve_args(),
                ]
                .concat(),
            }
        } else if self.resume {
            Mode::Resume {
                endpoint: self.endpoint,
            }
        } else if self.selftest {
            Mode::Selftest
        } else if self.schema {
            Mode::Schema
        } else {
            Mode::Stdio
        }
    }
}

const USAGE_ERROR: u8 = 2;

fn main() -> ExitCode {
    match Cli::parse().mode() {
        Mode::Schema => print_schema(),
        Mode::Oneshot { endpoint, serve_args } => match endpoint.map_or_else(client::default_endpoint, Ok) {
            Ok(endpoint) => {
                match oneshot::run(|request| client::exchange_or_start(&endpoint, &serve_args, request)) {
                    Ok(()) => ExitCode::SUCCESS,
                    Err(error) => fail(&format!("--oneshot: {error}")),
                }
            }
            Err(error) => fail(&format!("--oneshot: {error}")),
        },
        Mode::Resume { endpoint } => match endpoint.map_or_else(client::default_endpoint, Ok) {
            Ok(endpoint) => match client::resume(&endpoint) {
                Ok(status) => {
                    println!("{status}");
                    ExitCode::SUCCESS
                }
                Err(error) => fail(&format!("--resume: {error}")),
            },
            Err(error) => fail(&format!("--resume: {error}")),
        },
        Mode::Selftest => block_on(async {
            selftest::run_selftest()
                .await
                .map(|()| println!("engine: selftest ok"))
        }),
        Mode::Stdio => with_engine(|engine| async move {
            let served =
                connection::serve_connection(Arc::clone(&engine), tokio::io::stdin(), tokio::io::stdout())
                    .await;
            engine.shutdown().await;
            served.map_err(|error| error.to_string())
        }),
        Mode::Serve {
            endpoint,
            idle,
            daemon,
        } => with_engine(|engine| async move {
            daemon::open_daemon_session(&engine, &daemon, &client::token_file(&endpoint)).await?;
            serve::run_serve(engine, &endpoint, idle)
                .await
                .map_err(|error| format!("--serve {endpoint}: {error}"))
        }),
    }
}

fn print_schema() -> ExitCode {
    match serde_json::to_string_pretty(&senpi_desktop_core::engine_schema()) {
        Ok(schema) => {
            println!("{schema}");
            ExitCode::SUCCESS
        }
        Err(error) => fail(&format!("cannot encode the schema: {error}")),
    }
}

fn with_engine<F, Fut>(serve: F) -> ExitCode
where
    F: FnOnce(Arc<Engine>) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let config = match EngineConfig::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("senpi-desktop-engine: {error}");
            return ExitCode::from(USAGE_ERROR);
        }
    };
    match Engine::start(config) {
        Ok(engine) => block_on(serve(Arc::new(engine))),
        Err(error) => fail(&error.to_string()),
    }
}

fn block_on(work: impl std::future::Future<Output = Result<(), String>>) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => return fail(&format!("cannot start the async runtime: {error}")),
    };
    let outcome = runtime.block_on(work);
    // A session thread stuck in a backend call must not hold the exit.
    runtime.shutdown_background();
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => fail(&error),
    }
}

fn fail(message: &str) -> ExitCode {
    eprintln!("senpi-desktop-engine: {message}");
    ExitCode::FAILURE
}
