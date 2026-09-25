//! `senpi-desktop-engine`: the standalone desktop engine. JSON-RPC 2.0 over
//! NDJSON on stdio (default) or a local socket; `--selftest` and `--schema`
//! for locators and drift gates.

mod config;
mod connection;
mod engine;
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
#[command(group(ArgGroup::new("mode").args(["stdio", "serve", "oneshot", "selftest", "schema"])))]
struct Cli {
    /// Serve on stdin/stdout (the default).
    #[arg(long)]
    stdio: bool,
    /// Serve on a unix socket path or `\\.\pipe\<name>`, one client at a time.
    #[arg(long, value_name = "ENDPOINT")]
    serve: Option<String>,
    /// With --serve: exit after this long without a client.
    #[arg(long, value_name = "MS", default_value_t = 300_000, requires = "serve")]
    idle_ms: u64,
    /// Forward one request line to the --serve daemon (bunshin sidecar contract).
    #[arg(long)]
    oneshot: bool,
    /// Drive a built-in fake session and print `engine: selftest ok`.
    #[arg(long)]
    selftest: bool,
    /// Print the engine protocol JSON Schema.
    #[arg(long)]
    schema: bool,
}

enum Mode {
    Stdio,
    Serve { endpoint: String, idle: Duration },
    Oneshot,
    Selftest,
    Schema,
}

impl Cli {
    fn mode(self) -> Mode {
        if let Some(endpoint) = self.serve {
            Mode::Serve {
                endpoint,
                idle: Duration::from_millis(self.idle_ms),
            }
        } else if self.oneshot {
            Mode::Oneshot
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
        Mode::Oneshot => {
            eprintln!("senpi-desktop-engine: --oneshot is not available until the daemon bridge lands");
            ExitCode::from(USAGE_ERROR)
        }
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
        Mode::Serve { endpoint, idle } => with_engine(|engine| async move {
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
