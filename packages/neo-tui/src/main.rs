//! `senpi-neo-tui` binary entry.

use std::{
    io::{self, Write},
    path::{Path, PathBuf},
    process::ExitCode,
};

use clap::Parser;
use color_eyre::eyre::{Context, Result};

use senpi_neo_tui::{
    app::{self, AppConfig},
    components::{
        chat,
        footer::{FooterState, Status},
        header::HeaderState,
    },
    theme::{self, DEFAULT_THEME_ID, ThemeMode},
};

#[derive(Debug, Parser)]
#[command(
    name = "senpi-neo-tui",
    version,
    about = "Native Rust + ratatui TUI for senpi (launched via `senpi --neo`)."
)]
struct Cli {
    /// Path to senpi backend binary for `--mode rpc`. When set, the
    /// TUI spawns the backend on startup; otherwise the run is offline
    /// (demo mode or no agent activity).
    #[arg(long, env = "SENPI_NEO_BACKEND_BIN")]
    backend_bin: Option<PathBuf>,

    /// JSON array of args to forward to the backend, e.g.
    /// `["--mode","rpc"]`. Ignored when `--backend-bin` is unset.
    #[arg(long, env = "SENPI_NEO_BACKEND_ARGS", default_value = "[]")]
    backend_args: String,

    /// Render the canned demo state and exit after `--demo-seconds`.
    #[arg(long, env = "SENPI_NEO_DEMO", default_value_t = false)]
    demo: bool,

    /// Demo deadline in seconds (only with --demo). 0 = render until ctrl-c.
    #[arg(long, default_value_t = 0)]
    demo_seconds: u64,

    /// Override the theme by bundled id or JSON file path.
    #[arg(long, env = "SENPI_NEO_THEME")]
    theme: Option<String>,

    /// Print bundled theme ids and exit.
    #[arg(long)]
    list_themes: bool,
}

/// Decide whether a `--theme` argument is a file path vs a bundled id.
///
/// The previous heuristic (`value.contains('/')`) was too aggressive:
/// it treated `opencode/dracula` as a path and tried to `read_to_string`
/// it, even though that's a valid bundled id once the registry strips
/// the `opencode/` prefix. The new rule only triggers for explicit
/// filesystem indicators: an existing file, a `~/...` home expansion,
/// an absolute path, or a `./` / `../` relative path. Bundled ids
/// (`dracula`, `opencode/dracula`, ...) take the registry branch.
fn looks_like_theme_path(value: &str) -> bool {
    Path::new(value).is_file()
        || value.starts_with("~/")
        || value.starts_with("./")
        || value.starts_with("../")
        || value.starts_with('/')
}

fn main() -> ExitCode {
    color_eyre::install().ok();
    if let Err(err) = real_main() {
        eprintln!("senpi-neo-tui: {err:?}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

#[allow(clippy::too_many_lines)]
fn real_main() -> Result<()> {
    let cli = Cli::parse();

    if cli.list_themes {
        let mut stdout = io::stdout().lock();
        for id in theme::list_theme_ids() {
            writeln!(stdout, "{id}")?;
        }
        return Ok(());
    }

    let theme = match cli.theme.as_deref() {
        Some(value) if looks_like_theme_path(value) => {
            let path = value.strip_prefix("~/").map_or_else(
                || PathBuf::from(value),
                |rest| dirs::home_dir().map_or_else(|| PathBuf::from(value), |home| home.join(rest)),
            );
            let theme_json = std::fs::read_to_string(&path)
                .with_context(|| format!("reading theme json {}", path.display()))?;
            theme::resolve(&theme::parse(&theme_json)?)?
        }
        Some(id) => theme::load_by_id(id, ThemeMode::Dark)?,
        None => theme::load_by_id(DEFAULT_THEME_ID, ThemeMode::Dark)?,
    };

    let cwd_display = std::env::current_dir().map_or_else(
        |_| "?".into(),
        |p| {
            p.file_name()
                .map_or_else(|| "/".into(), |s| s.to_string_lossy().into_owned())
        },
    );

    // Demo mode keeps the fully-populated scene used for screenshots
    // and tests. Real `senpi --neo` boots into an empty session with an
    // idle footer so the user does not stare at a fake streaming run
    // until a real RPC frame arrives.
    let (initial_chat, header_state, footer_state) = if cli.demo {
        (
            chat::sample(),
            HeaderState {
                cwd: cwd_display,
                session: "session: feat/neo-tui".into(),
                branch: Some("feat/neo-tui".into()),
                branch_dirty: false,
                model: "claude-opus-4-7".into(),
                thinking_level: Some("max".into()),
                connected: true,
            },
            FooterState {
                status: Status::Streaming,
                status_label: "streaming response".into(),
                model: "claude-opus-4-7".into(),
                thinking: Some("max".into()),
                tps: Some(84),
                ctx_used_pct: 42,
                tokens_in: 12_400,
                tokens_out: 3_120,
                elapsed_secs: 0,
                spinner_glyph: '\u{2802}',
                connected: true,
                busy_label: None,
            },
        )
    } else {
        (
            chat::ChatState::default(),
            HeaderState {
                cwd: cwd_display,
                session: String::new(),
                branch: None,
                branch_dirty: false,
                model: String::new(),
                thinking_level: None,
                connected: false,
            },
            FooterState {
                status: Status::Idle,
                status_label: "ready".into(),
                model: String::new(),
                thinking: None,
                tps: None,
                ctx_used_pct: 0,
                tokens_in: 0,
                tokens_out: 0,
                elapsed_secs: 0,
                spinner_glyph: '\u{00b7}',
                connected: true,
                busy_label: None,
            },
        )
    };

    let config = AppConfig {
        theme,
        initial_chat,
        header: header_state,
        footer: footer_state,
        input_placeholder: "Ask senpi anything, or paste / drop / type · / for commands".into(),
        demo_mode: cli.demo,
        // demo_seconds is a demo-mode option; outside demo mode we ignore
        // it so a stray `--demo-seconds 5` does not auto-exit a real
        // session.
        demo_seconds: (cli.demo && cli.demo_seconds > 0).then_some(cli.demo_seconds),
    };

    // `maybe_spawn_backend()` in app::run reads SENPI_NEO_BACKEND_BIN
    // and SENPI_NEO_BACKEND_ARGS from the environment. Forward the
    // parsed CLI flags into the env so a direct binary invocation like
    // `senpi-neo-tui --backend-bin senpi --backend-args '["--mode","rpc"]'`
    // works without the caller needing to set the env vars manually.
    // SAFETY-NOTE: `std::env::set_var` is unsafe on multi-thread Linux
    // when other threads call `getenv` concurrently, but we mutate the
    // env BEFORE building the tokio runtime so the spawn is sequenced
    // before any concurrent reader.
    if let Some(bin) = cli.backend_bin.as_ref() {
        // SAFETY: single-threaded context at this point in main().
        unsafe { std::env::set_var("SENPI_NEO_BACKEND_BIN", bin) };
    }
    if cli.backend_args != "[]" {
        // SAFETY: single-threaded context at this point in main().
        unsafe { std::env::set_var("SENPI_NEO_BACKEND_ARGS", &cli.backend_args) };
    }

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(app::run(config))?;
    Ok(())
}
