//! Application loop and state container.
//!
//! Owns the terminal, drives a single `tokio::select!` loop multiplexing
//! crossterm events + render ticks, dispatches incoming keys through
//! the keymap, mutates per-component state, and (in a follow-up commit)
//! forwards user intents to the RPC client.

use std::{io::Stdout, time::Duration};

use color_eyre::eyre::Result;
use crossterm::{
    event::{
        DisableMouseCapture, EnableMouseCapture, Event, EventStream, KeyCode, KeyEvent,
        KeyEventKind, KeyModifiers,
    },
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use futures::StreamExt;
use ratatui::{Frame, Terminal, backend::CrosstermBackend};
use tokio::time::{Instant, MissedTickBehavior, interval};

use crate::{
    DEFAULT_DARK_THEME_JSON, DEFAULT_KEYMAP_JSON,
    components::{
        chat::{self, ChatState, Message, Role},
        footer::{self, FooterState, Status},
        header::{self, HeaderState},
        input::{self, InputState},
    },
    keymap::{self, FocusMode, ResolvedKeymap},
    layout::{self, LayoutState},
    theme::{self, ResolvedTheme},
};

const SPINNER_FRAMES: [char; 8] = ['⠂', '⠆', '⠒', '⠢', '⠖', '⠲', '⠴', '⠤'];
const SPINNER_FRAME_MS: u64 = 80;
const RENDER_INTERVAL_MS: u64 = 33;

/// Concrete outcome of one dispatched key event.
///
/// The run loop consumes these to drive side effects (send RPC, open
/// overlay, quit, etc.). Tests assert against the variant + payload to
/// lock the legacy binding semantics at runtime.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AppAction {
    /// Quit the run loop.
    Quit,
    /// Key was bound but the action is purely local (cursor moved,
    /// buffer mutated, status toggled). Carries the legacy binding ID
    /// for tracing / tests.
    Consumed(String),
    /// Key was either unbound or a non-press event.
    Ignored,
    /// User submitted the input buffer as a prompt. Payload is the
    /// (now drained) buffer contents.
    SubmitPrompt(String),
    /// User submitted the input buffer as a follow-up message.
    FollowUp(String),
    /// Open the model picker overlay (Ctrl+L).
    OpenModelPicker,
    /// Open the help overlay (?).
    OpenHelp,
    /// Open the command palette (Ctrl+Shift+P).
    OpenPalette,
    /// Cycle the active model forward (true) or backward (false).
    CycleModel { forward: bool },
    /// Cycle the thinking level (Shift+Tab).
    CycleThinkingLevel,
    /// Abort the in-flight generation (Escape during stream).
    Interrupt,
    /// Hand the input buffer to `$EDITOR` (Ctrl+G).
    ExternalEditor,
    /// Toggle thinking-block visibility in the chat (Ctrl+T).
    ToggleThinkingVisibility,
    /// Toggle tool-output expansion (Ctrl+O).
    ToggleToolsExpanded,
}

/// Stateful TUI application surface used by the run loop and behavioral
/// tests. Bundles the resolved keymap, focus mode, and every
/// per-component state struct the renderer consumes.
#[derive(Debug)]
pub struct App {
    pub keymap: ResolvedKeymap,
    pub focus: FocusMode,
    pub theme: ResolvedTheme,
    pub header: HeaderState,
    pub chat: ChatState,
    pub input: InputState,
    pub footer: FooterState,
    pub thinking_visible: bool,
    pub tools_expanded: bool,
}

impl App {
    /// Test-only factory. Loads the bundled keymap + dark theme + empty
    /// state. Returns Err only if the bundled assets are corrupted,
    /// which would also fail every other consumer at startup.
    pub fn for_tests() -> Result<Self> {
        let spec = keymap::parse(DEFAULT_KEYMAP_JSON)?;
        let keymap = ResolvedKeymap::compile(&spec)?;
        let theme = theme::load(DEFAULT_DARK_THEME_JSON)?;
        Ok(Self {
            keymap,
            focus: FocusMode::Input,
            theme,
            header: HeaderState {
                cwd: ".".into(),
                session: "test".into(),
                branch: None,
            },
            chat: ChatState::default(),
            input: InputState {
                buffer: String::new(),
                placeholder: "type your prompt".into(),
                mode_label: "INPUT".into(),
                focus_pulse: 0,
            },
            footer: FooterState {
                status: Status::Idle,
                status_label: "idle".into(),
                model: "claude-opus-4-7".into(),
                thinking: Some("high".into()),
                tps: None,
                ctx_used_pct: 0,
                tokens_in: 0,
                tokens_out: 0,
                elapsed_secs: 0,
                spinner_glyph: '⠂',
            },
            thinking_visible: true,
            tools_expanded: true,
        })
    }

    /// Read-only accessor used by tests and the renderer.
    #[must_use]
    pub fn input_buffer(&self) -> &str {
        &self.input.buffer
    }

    /// Read-only snapshot of the chat history.
    #[must_use]
    pub const fn chat_snapshot(&self) -> &ChatState {
        &self.chat
    }

    /// Drive one [`KeyEvent`] through the keymap and the action handler.
    /// Returns the resulting [`AppAction`] so the run loop can take side
    /// effects (send RPC, open overlay, quit, ...) without coupling
    /// state mutation to side-effect dispatch.
    pub fn handle_key(&mut self, event: KeyEvent) -> AppAction {
        if event.kind != KeyEventKind::Press {
            return AppAction::Ignored;
        }
        let id = self.keymap.dispatch(self.focus, &event);
        let Some(id) = id else {
            // Unbound key in Input focus -> insert literal character.
            // Skip when CTRL/ALT/SUPER held: those are dead chords the
            // user did not intend as text.
            if matches!(self.focus, FocusMode::Input) {
                if let KeyCode::Char(ch) = event.code {
                    let has_meta = event
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER);
                    if !has_meta {
                        self.input.buffer.push(ch);
                        return AppAction::Consumed("(literal)".into());
                    }
                }
            }
            return AppAction::Ignored;
        };
        // Borrow checker: keymap returns a &str into our own field, but
        // execute_action mutates self. Clone the ID up-front.
        let id_owned = id.to_owned();
        self.execute_action(&id_owned)
    }

    fn execute_action(&mut self, id: &str) -> AppAction {
        match id {
            // -- TUI-local app actions -------------------------------
            "app.exit" => {
                if self.input.buffer.is_empty() {
                    AppAction::Quit
                } else {
                    // Legacy senpi: Ctrl+D on a non-empty buffer falls
                    // through to delete-char-forward. With cursor-at-end
                    // there is nothing forward to delete, so this is a
                    // no-op rather than a quit.
                    AppAction::Consumed("tui.editor.deleteCharForward".into())
                }
            }
            "app.clear" => {
                self.input.buffer.clear();
                AppAction::Consumed(id.to_owned())
            }
            "app.interrupt" => AppAction::Interrupt,
            // -- Model + thinking ------------------------------------
            "app.model.cycleForward" => AppAction::CycleModel { forward: true },
            "app.model.cycleBackward" => AppAction::CycleModel { forward: false },
            "app.model.select" => AppAction::OpenModelPicker,
            "app.thinking.cycle" => AppAction::CycleThinkingLevel,
            "app.thinking.toggle" => {
                self.thinking_visible = !self.thinking_visible;
                AppAction::ToggleThinkingVisibility
            }
            "app.tools.expand" => {
                self.tools_expanded = !self.tools_expanded;
                AppAction::ToggleToolsExpanded
            }
            "app.editor.external" => AppAction::ExternalEditor,
            "app.message.followUp" => {
                let text = std::mem::take(&mut self.input.buffer);
                AppAction::FollowUp(text)
            }
            // -- Editor primitives ------------------------------------
            "tui.input.submit" => {
                let text = std::mem::take(&mut self.input.buffer);
                if !text.is_empty() {
                    self.chat.messages.push(Message {
                        role: Role::User,
                        body: text.clone(),
                        tool: None,
                    });
                }
                AppAction::SubmitPrompt(text)
            }
            "tui.input.newLine" => {
                self.input.buffer.push('\n');
                AppAction::Consumed(id.to_owned())
            }
            "tui.editor.deleteCharBackward" => {
                self.input.buffer.pop();
                AppAction::Consumed(id.to_owned())
            }
            "tui.editor.deleteCharForward" => {
                if self.input.buffer.is_empty() {
                    AppAction::Quit
                } else {
                    AppAction::Consumed(id.to_owned())
                }
            }
            // -- neo-* additions --------------------------------------
            "neo.help" | "neo.help.open" => AppAction::OpenHelp,
            "neo.palette.open" => AppAction::OpenPalette,
            // -- Everything else is recognized but not yet acted on. --
            _ => AppAction::Consumed(id.to_owned()),
        }
    }
}

/// Inputs accepted by the app loop.
#[derive(Clone, Debug)]
pub struct AppConfig {
    pub theme: ResolvedTheme,
    pub initial_chat: ChatState,
    pub header: HeaderState,
    pub footer: FooterState,
    pub input_placeholder: String,
    pub demo_mode: bool,
    pub demo_seconds: Option<u64>,
}

/// Run the TUI to completion. Restores the terminal on exit.
pub async fn run(config: AppConfig) -> Result<()> {
    let mut terminal = init_terminal()?;
    let result = drive(&mut terminal, config).await;
    restore_terminal(&mut terminal)?;
    result
}

fn init_terminal() -> Result<Terminal<CrosstermBackend<Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    if let Err(err) = execute!(stdout, EnterAlternateScreen) {
        let _ = disable_raw_mode();
        return Err(err.into());
    }
    if let Err(err) = execute!(stdout, EnableMouseCapture) {
        let _ = execute!(std::io::stdout(), LeaveAlternateScreen);
        let _ = disable_raw_mode();
        return Err(err.into());
    }
    let backend = CrosstermBackend::new(stdout);
    match Terminal::new(backend) {
        Ok(term) => Ok(term),
        Err(err) => {
            let _ = execute!(
                std::io::stdout(),
                LeaveAlternateScreen,
                DisableMouseCapture
            );
            let _ = disable_raw_mode();
            Err(err.into())
        }
    }
}

fn restore_terminal(terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> Result<()> {
    disable_raw_mode()?;
    execute!(std::io::stdout(), LeaveAlternateScreen, DisableMouseCapture)?;
    terminal.show_cursor()?;
    Ok(())
}

async fn drive(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    config: AppConfig,
) -> Result<()> {
    let AppConfig {
        theme,
        initial_chat,
        header,
        mut footer,
        input_placeholder,
        demo_mode,
        demo_seconds,
    } = config;

    let mut chat = initial_chat;
    let mut input_state = InputState {
        buffer: String::new(),
        placeholder: input_placeholder,
        mode_label: "INPUT".to_string(),
        focus_pulse: 0,
    };

    let mut events = EventStream::new();
    let mut render_tick = interval(Duration::from_millis(RENDER_INTERVAL_MS));
    render_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut spinner_tick = interval(Duration::from_millis(SPINNER_FRAME_MS));
    spinner_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let start = Instant::now();
    let mut spinner_idx: usize = 0;
    let demo_deadline = demo_seconds.map(|s| start + Duration::from_secs(s));

    loop {
        if let Some(deadline) = demo_deadline {
            if Instant::now() >= deadline {
                break;
            }
        }

        tokio::select! {
            biased;
            _ = render_tick.tick() => {
                footer.spinner_glyph = SPINNER_FRAMES[spinner_idx];
                footer.elapsed_secs = start.elapsed().as_secs();
                terminal.draw(|frame| {
                    draw(frame, &theme, &header, &chat, &input_state, &footer);
                })?;
            }
            _ = spinner_tick.tick() => {
                spinner_idx = (spinner_idx + 1) % SPINNER_FRAMES.len();
                input_state.focus_pulse = input_state.focus_pulse.wrapping_add(8);
            }
            ev = events.next() => {
                if let Some(Ok(event)) = ev {
                    if handle_event(
                        &event,
                        &mut chat,
                        &mut input_state,
                        &mut footer,
                        demo_mode,
                    ) {
                        break;
                    }
                }
            }
        }
    }

    Ok(())
}

fn draw(
    frame: &mut Frame<'_>,
    theme: &ResolvedTheme,
    header_state: &HeaderState,
    chat_state: &ChatState,
    input_state: &InputState,
    footer_state: &FooterState,
) {
    let area = frame.area();
    let line_count = input_state.buffer.lines().count().max(1);
    let computed = layout::compute(
        area,
        LayoutState {
            input_lines: u16::try_from(line_count).unwrap_or(1),
            sidebar_visible: area.width >= layout::SIDEBAR_MIN_TERMINAL_WIDTH,
        },
    );

    header::render(frame, computed.header, theme, header_state);
    chat::render(frame, computed.chat, theme, chat_state);
    input::render(frame, computed.input, theme, input_state);
    footer::render(frame, computed.footer, theme, footer_state);
}

fn handle_event(
    event: &Event,
    _chat: &mut ChatState,
    input_state: &mut InputState,
    _footer: &mut FooterState,
    demo_mode: bool,
) -> bool {
    let Event::Key(KeyEvent {
        code,
        modifiers,
        kind,
        ..
    }) = event
    else {
        return false;
    };
    if *kind != KeyEventKind::Press {
        return false;
    }
    if demo_mode {
        if matches!(code, KeyCode::Char('c')) && modifiers.contains(KeyModifiers::CONTROL) {
            return true;
        }
        return false;
    }
    match code {
        KeyCode::Char('c' | 'd') if modifiers.contains(KeyModifiers::CONTROL) => true,
        KeyCode::Backspace => {
            input_state.buffer.pop();
            false
        }
        KeyCode::Char(ch) => {
            input_state.buffer.push(*ch);
            false
        }
        _ => false,
    }
}
