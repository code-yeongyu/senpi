//! Application loop and state container.
//!
//! Owns the terminal, drives a single `tokio::select!` loop multiplexing
//! crossterm events + render ticks + inbound RPC frames, dispatches
//! incoming keys through the keymap, mutates per-component state, and
//! forwards user intents to the RPC backend.

use std::{
    io::{Stdout, Write},
    path::PathBuf,
    time::Duration,
};

use color_eyre::eyre::Result;
use crossterm::{
    event::{
        DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event as CrosstermEvent, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEvent,
        MouseEventKind, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
    },
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use futures::StreamExt;
use ratatui::{
    Frame, Terminal,
    backend::CrosstermBackend,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Clear, List, ListItem, ListState},
};
use tokio::sync::mpsc;
use tokio::time::{Instant, MissedTickBehavior, interval};

use crate::{
    DEFAULT_DARK_THEME_JSON, DEFAULT_KEYMAP_JSON,
    components::{
        autocomplete::{Autocomplete, AutocompleteResult, CompletionItem},
        chat::{self, ChatState, Message, Role, ToolCard, ToolStatus},
        footer::{self, FooterState, Status},
        header::{self, HeaderState},
        input::{self, InputState},
    },
    keymap::{self, FocusMode, ResolvedKeymap},
    layout::{self, LayoutState},
    overlay::{HelpOverlay, Overlay, OverlayResult, PaletteOverlay, SlashOverlay},
    rpc::{
        client::{Inbound, RpcClient},
        command::Command,
        event::Event as RpcEvent,
    },
    term::TerminalCaps,
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
    /// Open the command palette (Alt+P).
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
    pub autocomplete: Autocomplete,
    pub autocomplete_popup: Option<Vec<CompletionItem>>,
    pub autocomplete_index: usize,
    pub footer: FooterState,
    pub thinking_visible: bool,
    pub tools_expanded: bool,
    /// Active overlay (Help / Slash / Palette) drawn on top of the
    /// chat view. `None` = no overlay.
    pub overlay: Option<Overlay>,
    /// `true` when the binary was launched with `--demo`. Drives the
    /// sidebar visibility and other demo-only render switches so real
    /// `senpi --neo` runs do not look like a fake streaming session.
    pub demo_mode: bool,
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
                branch_dirty: false,
                model: String::new(),
                thinking_level: None,
                connected: false,
            },
            chat: ChatState::default(),
            input: InputState::new("Ask senpi anything…", "INPUT"),
            autocomplete: Autocomplete::new(),
            autocomplete_popup: None,
            autocomplete_index: 0,
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
                spinner_glyph: '\u{2802}',
                connected: true,
                busy_label: None,
            },
            thinking_visible: true,
            tools_expanded: true,
            overlay: None,
            demo_mode: false,
        })
    }

    pub fn input_buffer(&self) -> &str {
        &self.input.buffer
    }

    /// Read-only snapshot of the chat history.
    #[must_use]
    pub const fn chat_snapshot(&self) -> &ChatState {
        &self.chat
    }

    pub fn init_terminal_writes() -> Vec<u8> {
        TerminalCaps::detect().init_writes()
    }

    pub fn cleanup_terminal_writes() -> Vec<u8> {
        TerminalCaps::detect().cleanup_writes()
    }

    pub fn compute_autocomplete(&mut self) -> AutocompleteResult {
        let cwd = self.autocomplete_cwd();
        let result = self.autocomplete.trigger(&self.input.buffer, &cwd);
        self.store_autocomplete_result(&result);
        result
    }

    pub fn handle_mouse(&mut self, event: MouseEvent) -> AppAction {
        match event.kind {
            MouseEventKind::ScrollUp => {
                self.chat.scroll_up(3);
                AppAction::Consumed("tui.chat.scrollUp".into())
            }
            MouseEventKind::ScrollDown => {
                self.chat.scroll_down(3);
                AppAction::Consumed("tui.chat.scrollDown".into())
            }
            _ => AppAction::Ignored,
        }
    }

    fn autocomplete_cwd(&self) -> PathBuf {
        if self.header.cwd.is_empty() {
            PathBuf::from(".")
        } else {
            PathBuf::from(&self.header.cwd)
        }
    }

    fn store_autocomplete_result(&mut self, result: &AutocompleteResult) {
        let items = match result {
            AutocompleteResult::Slash(items) | AutocompleteResult::Path(items) if !items.is_empty() => {
                Some(items.clone())
            }
            AutocompleteResult::None | AutocompleteResult::Slash(_) | AutocompleteResult::Path(_) => None,
        };
        self.autocomplete_popup = items;
        if let Some(items) = self.autocomplete_popup.as_ref() {
            self.autocomplete_index = self.autocomplete_index.min(items.len().saturating_sub(1));
        } else {
            self.autocomplete_index = 0;
        }
    }

    fn refresh_autocomplete(&mut self) {
        let _ = self.compute_autocomplete();
    }

    fn clear_autocomplete(&mut self) {
        self.autocomplete_popup = None;
        self.autocomplete_index = 0;
    }

    fn select_previous_autocomplete(&mut self) {
        let Some(items) = self.autocomplete_popup.as_ref() else {
            return;
        };
        if items.is_empty() {
            self.autocomplete_index = 0;
        } else if self.autocomplete_index == 0 {
            self.autocomplete_index = items.len() - 1;
        } else {
            self.autocomplete_index -= 1;
        }
    }

    fn select_next_autocomplete(&mut self) {
        let Some(items) = self.autocomplete_popup.as_ref() else {
            return;
        };
        if items.is_empty() {
            self.autocomplete_index = 0;
        } else {
            self.autocomplete_index = (self.autocomplete_index + 1) % items.len();
        }
    }

    fn apply_selected_autocomplete(&mut self) -> bool {
        let Some(item) = self
            .autocomplete_popup
            .as_ref()
            .and_then(|items| items.get(self.autocomplete_index))
            .cloned()
        else {
            return false;
        };
        let Some(range) = self.autocomplete_replacement_range() else {
            return false;
        };
        self.input.buffer.replace_range(range.clone(), &item.insert);
        self.input.cursor = range.start + item.insert.len();
        self.input.preferred_column = None;
        self.refresh_autocomplete();
        true
    }

    fn autocomplete_replacement_range(&self) -> Option<std::ops::Range<usize>> {
        let cursor = self.input.cursor.min(self.input.buffer.len());
        let prefix = &self.input.buffer[..cursor];
        if prefix.starts_with('/') {
            return Some(0..cursor);
        }
        let token_start = prefix
            .char_indices()
            .rev()
            .find_map(|(idx, ch)| ch.is_whitespace().then_some(idx + ch.len_utf8()))
            .unwrap_or(0);
        prefix[token_start..]
            .starts_with('@')
            .then_some(token_start..cursor)
    }

    /// Drive one [`KeyEvent`] through the keymap and the action handler.
    /// Returns the resulting [`AppAction`] so the run loop can take side
    /// effects (send RPC, open overlay, quit, ...) without coupling
    /// state mutation to side-effect dispatch.
    pub fn handle_key(&mut self, event: KeyEvent) -> AppAction {
        if event.kind != KeyEventKind::Press {
            return AppAction::Ignored;
        }
        // Modal overlays consume the key. Dispatch through the keymap
        // with `Dialog` focus first so users can rebind
        // `tui.select.up`, `tui.select.confirm`, `tui.select.cancel`,
        // etc. and have those rebindings apply uniformly to every
        // overlay. When the chord resolves to a recognised overlay
        // action (`tui.select.*` plus the filter-delete binding)
        // synthesise the canonical `KeyEvent` for the existing raw
        // overlay handlers. When the chord resolves to anything else,
        // swallow the keystroke so the overlay does not fall through
        // to its hardcoded raw handler (which would otherwise bypass
        // a user's rebinding). Unresolved chords (plain printable
        // chars that the keymap does not bind) reach the overlay raw
        // for filter typing.
        if let Some(overlay) = self.overlay.as_mut() {
            let resolved = self.keymap.dispatch(FocusMode::Dialog, &event);
            let dispatched_event = match resolved {
                Some(id) => match synthesise_select_event(id) {
                    Some(synth) => synth,
                    None => return AppAction::Consumed("(overlay-blocked)".into()),
                },
                None => event,
            };
            match overlay.handle_key(dispatched_event) {
                OverlayResult::Close => {
                    self.overlay = None;
                    return AppAction::Consumed("(overlay-closed)".into());
                }
                OverlayResult::Continue => {
                    return AppAction::Consumed("(overlay)".into());
                }
                OverlayResult::Selected(picked) => {
                    self.overlay = None;
                    return self.execute_action(&picked);
                }
            }
        }
        let resolved = self.keymap.dispatch(self.focus, &event);
        // Some overlay-opener bindings (`neo.slash.open`, `neo.help`)
        // carry a buffer-empty + Input-focus precondition that the
        // keymap cannot encode. When the chord resolves but the
        // precondition fails (mid-prompt `/` or `?`), drop the action
        // so the literal-character fallback inserts the keystroke
        // as-is.
        let id = match resolved {
            Some("neo.slash.open") => {
                if matches!(self.focus, FocusMode::Input) && self.input.buffer.is_empty() {
                    self.overlay = Some(Overlay::Slash(SlashOverlay::new()));
                    return AppAction::Consumed("neo.slash.open".into());
                }
                None
            }
            Some("neo.help" | "neo.help.open") => {
                if matches!(self.focus, FocusMode::Input) && !self.input.buffer.is_empty() {
                    None
                } else {
                    self.overlay = Some(Overlay::Help(HelpOverlay::from_keymap(&self.keymap)));
                    return AppAction::OpenHelp;
                }
            }
            other => other,
        };
        let Some(id) = id else {
            if matches!(self.focus, FocusMode::Input) {
                if let KeyCode::Char(ch) = event.code {
                    let has_meta = event
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER);
                    if !has_meta {
                        self.input.insert_char(ch);
                        self.refresh_autocomplete();
                        return AppAction::Consumed("(literal)".into());
                    }
                }
            }
            return AppAction::Ignored;
        };
        let id_owned = id.to_owned();
        self.execute_action(&id_owned)
    }

    /// Apply a `tui.editor.*` cursor/delete action against `InputState`.
    /// Returns `None` for actions that are not editor cursor or delete
    /// operations so the main dispatcher can handle them.
    fn try_editor_action(&mut self, id: &str) -> Option<AppAction> {
        match id {
            "tui.editor.cursorLeft" => self.input.cursor_left(),
            "tui.editor.cursorRight" => self.input.cursor_right(),
            "tui.editor.cursorUp" | "tui.input.historyPrev" => {
                if self.input.recall_prev_history().is_some() {
                    self.refresh_autocomplete();
                    return Some(AppAction::Consumed("tui.input.historyPrev".into()));
                }
                self.input.cursor_up();
            }
            "tui.editor.cursorDown" | "tui.input.historyNext" => {
                if self.input.recall_next_history().is_some() {
                    self.refresh_autocomplete();
                    return Some(AppAction::Consumed("tui.input.historyNext".into()));
                }
                self.input.cursor_down();
            }
            "tui.editor.jumpBackward" => self.input.cursor_up(),
            "tui.editor.jumpForward" => self.input.cursor_down(),
            "tui.editor.cursorWordLeft" => self.input.cursor_word_left(),
            "tui.editor.cursorWordRight" => self.input.cursor_word_right(),
            "tui.editor.cursorLineStart" => self.input.cursor_line_start(),
            "tui.editor.cursorLineEnd" => self.input.cursor_line_end(),
            "tui.editor.pageUp" => self.input.page_up(),
            "tui.editor.pageDown" => self.input.page_down(),
            "tui.editor.deleteCharBackward" => self.input.delete_char_backward(),
            "tui.editor.deleteWordBackward" => self.input.delete_word_backward(),
            "tui.editor.deleteWordForward" => self.input.delete_word_forward(),
            "tui.editor.deleteToLineStart" => self.input.delete_to_line_start(),
            "tui.editor.deleteToLineEnd" => self.input.delete_to_line_end(),
            "tui.editor.yank" => self.input.yank(),
            "tui.editor.yankPop" => self.input.yank_pop(),
            "tui.editor.undo" => self.input.undo(),
            "tui.editor.newLine" => self.input.insert_newline(),
            _ => return None,
        }
        self.refresh_autocomplete();
        Some(AppAction::Consumed(id.to_owned()))
    }

    fn try_autocomplete_action(&mut self, id: &str) -> Option<AppAction> {
        if self.autocomplete_popup.as_ref().is_none_or(Vec::is_empty) {
            return None;
        }
        match id {
            "tui.editor.cursorUp" | "tui.input.historyPrev" => {
                self.select_previous_autocomplete();
                Some(AppAction::Consumed("tui.autocomplete.previous".into()))
            }
            "tui.editor.cursorDown" | "tui.input.historyNext" => {
                self.select_next_autocomplete();
                Some(AppAction::Consumed("tui.autocomplete.next".into()))
            }
            "tui.input.tab" => {
                self.apply_selected_autocomplete();
                Some(AppAction::Consumed("tui.input.tab".into()))
            }
            _ => None,
        }
    }

    fn execute_action(&mut self, id: &str) -> AppAction {
        if let Some(action) = self.try_autocomplete_action(id) {
            return action;
        }
        if let Some(action) = self.try_editor_action(id) {
            return action;
        }
        match id {
            "app.exit" => {
                if self.input.buffer.is_empty() {
                    AppAction::Quit
                } else {
                    // Legacy senpi: Ctrl+D on a non-empty buffer falls
                    // through to delete-char-forward, which is a no-op
                    // at end-of-line.
                    AppAction::Consumed("tui.editor.deleteCharForward".into())
                }
            }
            "app.clear" => {
                self.input.clear();
                self.clear_autocomplete();
                AppAction::Consumed(id.to_owned())
            }
            "tui.input.copy" => {
                // Legacy senpi: Ctrl+C with a non-empty buffer clears
                // the input (a quick "discard this prompt" gesture).
                // With an empty buffer it interrupts the current turn
                // instead. Without that branch the chord matched in
                // Input focus but did nothing visible.
                if self.input.buffer.is_empty() {
                    AppAction::Interrupt
                } else {
                    self.input.clear();
                    self.clear_autocomplete();
                    AppAction::Consumed(id.to_owned())
                }
            }
            "app.interrupt" => AppAction::Interrupt,
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
                let text = self.input.take_buffer();
                if !text.is_empty() {
                    self.input.push_history(&text);
                }
                self.clear_autocomplete();
                AppAction::FollowUp(text)
            }
            "tui.input.submit" => {
                let text = self.input.take_buffer();
                if !text.is_empty() {
                    self.input.push_history(&text);
                    self.chat.messages.push(Message {
                        role: Role::User,
                        body: text.clone(),
                        tool: None,
                    });
                    // Reflect the submit immediately so the UI doesn't
                    // sit at `idle` for the round-trip window before the
                    // first AgentStart event arrives. apply_event will
                    // overwrite the label as soon as real events flow.
                    self.footer.status = Status::Busy;
                    self.footer.status_label = "waiting".into();
                }
                self.clear_autocomplete();
                AppAction::SubmitPrompt(text)
            }
            "tui.input.newLine" => {
                self.input.insert_newline();
                self.refresh_autocomplete();
                AppAction::Consumed(id.to_owned())
            }
            "tui.editor.deleteCharForward" => {
                if self.input.buffer.is_empty() {
                    AppAction::Quit
                } else {
                    self.input.delete_char_forward();
                    self.refresh_autocomplete();
                    AppAction::Consumed(id.to_owned())
                }
            }
            "neo.help" | "neo.help.open" => {
                self.overlay = Some(Overlay::Help(HelpOverlay::from_keymap(&self.keymap)));
                AppAction::OpenHelp
            }
            "neo.palette.open" => {
                self.overlay = Some(Overlay::Palette(PaletteOverlay::from_keymap(&self.keymap)));
                AppAction::OpenPalette
            }
            _ => AppAction::Consumed(id.to_owned()),
        }
    }

    /// Translate a finished [`AppAction`] into the RPC [`Command`] the
    /// backend should receive (if any). Returns `None` for actions
    /// that stay purely TUI-local (overlay open/close, focus toggles,
    /// quit, literal-char insertion, ...).
    ///
    /// `CycleModel { forward }` maps to `Command::CycleModel`
    /// unconditionally because the wire protocol only supports forward
    /// cycling today; the `forward` discriminator survives on
    /// [`AppAction`] for future UI use.
    #[must_use]
    pub fn action_to_command(action: &AppAction) -> Option<Command> {
        match action {
            AppAction::SubmitPrompt(text) if !text.is_empty() => Some(Command::Prompt {
                id: None,
                message: text.clone(),
                streaming_behavior: None,
            }),
            AppAction::FollowUp(text) if !text.is_empty() => Some(Command::FollowUp {
                id: None,
                message: text.clone(),
            }),
            AppAction::Interrupt => Some(Command::Abort { id: None }),
            AppAction::CycleModel { .. } => Some(Command::CycleModel { id: None }),
            AppAction::CycleThinkingLevel => Some(Command::CycleThinkingLevel { id: None }),
            AppAction::OpenModelPicker => Some(Command::GetAvailableModels { id: None }),
            _ => None,
        }
    }

    /// Apply a single inbound RPC frame to the app's renderable state.
    /// Streaming text accumulates in the last assistant message, tool
    /// cards land as their own messages, and footer status tracks the
    /// agent/turn lifecycle.
    pub fn apply_inbound(&mut self, msg: Inbound) {
        match msg {
            Inbound::Event(event) => self.apply_event(event),
            Inbound::Response(_) => {}
            Inbound::Error {
                exit_code,
                stderr_tail,
            } => {
                let detail = exit_code.map_or_else(
                    || "backend exited before reporting a status".to_string(),
                    |code| format!("backend exited with status {code}"),
                );
                let body = if stderr_tail.trim().is_empty() {
                    detail
                } else {
                    format!("{detail}\n{stderr_tail}")
                };
                self.chat.messages.push(Message {
                    role: Role::Error,
                    body,
                    tool: None,
                });
                self.footer.status = Status::Error;
                self.footer.status_label = "error".into();
            }
            Inbound::Disconnected => {
                self.footer.status = Status::Idle;
                self.footer.status_label = "disconnected".into();
            }
            Inbound::ParseError { line, source } => {
                self.chat.messages.push(Message {
                    role: Role::Error,
                    body: format!("failed to parse backend output: {source}\n{line}"),
                    tool: None,
                });
                self.footer.status = Status::Error;
                self.footer.status_label = "error".into();
            }
        }
    }

    fn apply_event(&mut self, event: RpcEvent) {
        match event {
            RpcEvent::AgentStart => {
                self.footer.status = Status::Busy;
                self.footer.status_label = "thinking".into();
            }
            RpcEvent::AgentEnd { .. } => {
                self.footer.status = Status::Idle;
                self.footer.status_label = "idle".into();
            }
            RpcEvent::MessageEnd { .. } => {
                // Drop the assistant bubble entirely when the backend
                // produced only thinking deltas (or nothing) for this
                // message - otherwise an empty `senpi` block sits in
                // the chat in front of the real response.
                if let Some(last) = self.chat.messages.last()
                    && matches!(last.role, Role::Assistant)
                    && last.body.is_empty()
                    && last.tool.is_none()
                {
                    self.chat.messages.pop();
                }
                self.footer.status = Status::Idle;
                self.footer.status_label = "idle".into();
            }
            RpcEvent::MessageStart { .. } => {
                // Do NOT push an empty assistant bubble here. The backend
                // emits one `message_start` per content block (e.g.
                // thinking, response), and only some carry visible
                // text. Pushing on every start produced a phantom empty
                // `senpi` row before the real reply. We now create the
                // bubble lazily on the first text_delta in
                // `MessageUpdate`.
                self.footer.status = Status::Streaming;
                self.footer.status_label = "streaming".into();
            }
            RpcEvent::MessageUpdate {
                assistant_message_event,
                ..
            } => {
                let delta = assistant_message_event.as_ref().and_then(|v| {
                    let kind = v.get("type").and_then(serde_json::Value::as_str)?;
                    if kind == "text_delta" {
                        v.get("delta").and_then(serde_json::Value::as_str)
                    } else {
                        None
                    }
                });
                if let Some(text) = delta {
                    let needs_new_bubble = self
                        .chat
                        .messages
                        .last()
                        .is_none_or(|m| !matches!(m.role, Role::Assistant) || m.tool.is_some());
                    if needs_new_bubble {
                        self.chat.messages.push(Message {
                            role: Role::Assistant,
                            body: String::new(),
                            tool: None,
                        });
                    }
                    if let Some(last) = self.chat.messages.last_mut() {
                        last.body.push_str(text);
                    }
                }
            }
            RpcEvent::ToolExecutionStart { tool_name, args, .. } => {
                self.chat.messages.push(Message {
                    role: Role::Assistant,
                    body: String::new(),
                    tool: Some(ToolCard {
                        name: tool_name,
                        status: ToolStatus::Running,
                        summary: args.to_string(),
                    }),
                });
                self.footer.status = Status::ToolRunning;
                self.footer.status_label = "tool".into();
            }
            RpcEvent::ToolExecutionEnd {
                tool_name, is_error, ..
            } => {
                for msg in self.chat.messages.iter_mut().rev() {
                    if let Some(tool) = msg.tool.as_mut()
                        && tool.name == tool_name
                        && matches!(tool.status, ToolStatus::Running)
                    {
                        tool.status = if is_error {
                            ToolStatus::Failed
                        } else {
                            ToolStatus::Success
                        };
                        break;
                    }
                }
                self.footer.status = Status::Streaming;
                self.footer.status_label = "streaming".into();
            }
            RpcEvent::ExtensionError { error, .. } => {
                self.chat.messages.push(Message {
                    role: Role::Error,
                    body: error,
                    tool: None,
                });
                self.footer.status = Status::Error;
                self.footer.status_label = "error".into();
            }
            _ => {}
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

impl App {
    /// Build an [`App`] from an [`AppConfig`]. Uses the bundled keymap;
    /// future iterations will load a user-override keymap from
    /// `~/.senpi/agent/neo-keymap.json` if present.
    pub fn from_config(config: AppConfig) -> Result<Self> {
        let spec = keymap::parse(DEFAULT_KEYMAP_JSON)?;
        let resolved = ResolvedKeymap::compile(&spec)?;
        Ok(Self {
            keymap: resolved,
            focus: FocusMode::Input,
            theme: config.theme,
            header: config.header,
            chat: config.initial_chat,
            input: InputState::new(config.input_placeholder, "INPUT"),
            autocomplete: Autocomplete::new(),
            autocomplete_popup: None,
            autocomplete_index: 0,
            footer: config.footer,
            thinking_visible: true,
            tools_expanded: true,
            overlay: None,
            demo_mode: config.demo_mode,
        })
    }
}

/// Run the TUI to completion. Restores the terminal on exit.
pub async fn run(config: AppConfig) -> Result<()> {
    let mut terminal = init_terminal()?;
    let result = drive(&mut terminal, config).await;
    restore_terminal(&mut terminal)?;
    result
}

/// Translate a resolved action ID into the canonical `KeyEvent` shape
/// the per-overlay raw handlers already understand. Covers the
/// `tui.select.*` family plus the `tui.editor.deleteCharBackward`
/// chord because the latter doubles as the overlay's filter-delete
/// gesture when an overlay is open. Returns `None` for any other
/// action so unresolved keystrokes do not silently steer overlay
/// behaviour past a user's explicit rebinding.
fn synthesise_select_event(action_id: &str) -> Option<KeyEvent> {
    let code = match action_id {
        "tui.select.up" => KeyCode::Up,
        "tui.select.down" => KeyCode::Down,
        "tui.select.pageUp" => KeyCode::PageUp,
        "tui.select.pageDown" => KeyCode::PageDown,
        "tui.select.confirm" => KeyCode::Enter,
        "tui.select.cancel" => KeyCode::Esc,
        "tui.editor.deleteCharBackward" => KeyCode::Backspace,
        _ => return None,
    };
    Some(KeyEvent {
        code,
        modifiers: KeyModifiers::NONE,
        kind: KeyEventKind::Press,
        state: crossterm::event::KeyEventState::NONE,
    })
}

fn init_terminal() -> Result<Terminal<CrosstermBackend<Stdout>>> {
    let caps = TerminalCaps::detect();
    write_terminal_bytes(&caps.init_writes())?;
    if let Err(err) = enable_raw_mode() {
        let _ = write_terminal_bytes(&caps.cleanup_writes());
        return Err(err.into());
    }
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
    // Bracketed paste lets the terminal deliver clipboard pastes as a
    // single `CrosstermEvent::Paste(String)` instead of a flood of
    // synthetic keypress events. Critical for CJK / IME paste which
    // would otherwise stream through one composing char at a time and
    // mangle the cursor.
    let _ = execute!(stdout, EnableBracketedPaste);
    // Best-effort: enable Kitty keyboard protocol so the run loop can
    // see `shift+enter` distinct from `enter` (and ctrl-letters with
    // their original case). Terminals that ignore the escape silently
    // fall back to legacy key reporting, so we deliberately do not fail
    // the boot when this errors.
    let _ = execute!(stdout, PushKeyboardEnhancementFlags(caps.kitty_keyboard_flags),);
    let backend = CrosstermBackend::new(stdout);
    match Terminal::new(backend) {
        Ok(term) => Ok(term),
        Err(err) => {
            let _ = execute!(
                std::io::stdout(),
                PopKeyboardEnhancementFlags,
                LeaveAlternateScreen,
                DisableMouseCapture
            );
            let _ = disable_raw_mode();
            Err(err.into())
        }
    }
}

fn restore_terminal(terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> Result<()> {
    let caps = TerminalCaps::detect();
    disable_raw_mode()?;
    let _ = write_terminal_bytes(&caps.cleanup_writes());
    let _ = execute!(std::io::stdout(), PopKeyboardEnhancementFlags);
    let _ = execute!(std::io::stdout(), DisableBracketedPaste);
    execute!(std::io::stdout(), LeaveAlternateScreen, DisableMouseCapture)?;
    terminal.show_cursor()?;
    Ok(())
}

fn write_terminal_bytes(bytes: &[u8]) -> std::io::Result<()> {
    let mut stdout = std::io::stdout();
    stdout.write_all(bytes)?;
    stdout.flush()
}

/// Spawn the RPC backend if `SENPI_NEO_BACKEND_BIN` is set in the
/// environment. `SENPI_NEO_BACKEND_ARGS` carries the extra args as a
/// JSON-encoded string array so arguments with embedded whitespace
/// (e.g. `--system-prompt "..."`) survive intact. Returns `None`
/// when env is unset or the spawn fails; the TUI then falls back to
/// render-only so demos, screenshots, and unit tests run with no
/// backend present.
fn maybe_spawn_backend() -> Option<RpcClient> {
    let bin = std::env::var_os("SENPI_NEO_BACKEND_BIN")?;
    let args = parse_backend_args(&std::env::var("SENPI_NEO_BACKEND_ARGS").unwrap_or_default());
    RpcClient::spawn(&bin, &args).ok()
}

/// Decode the `SENPI_NEO_BACKEND_ARGS` env value into a runnable arg
/// vector. The Node-side dispatcher writes a JSON-encoded array; older
/// callers may still pass a whitespace-separated string. Honors both
/// to keep the contract forgiving while we transition.
fn parse_backend_args(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if let Ok(parsed) = serde_json::from_str::<Vec<String>>(trimmed) {
        return parsed;
    }
    trimmed.split_whitespace().map(str::to_owned).collect()
}

async fn drive(terminal: &mut Terminal<CrosstermBackend<Stdout>>, config: AppConfig) -> Result<()> {
    let demo_mode = config.demo_mode;
    let demo_seconds = config.demo_seconds;
    let mut app = App::from_config(config)?;

    // Demo mode keeps the loop pure-render so screenshots and tests
    // do not require a backend on the host. Production paths set
    // SENPI_NEO_BACKEND_BIN to either senpi --mode rpc or the QA
    // harness's senpi-neo-faux binary.
    let mut backend: Option<RpcClient> = if demo_mode { None } else { maybe_spawn_backend() };
    let mut inbound: Option<mpsc::Receiver<Inbound>> = backend.as_mut().and_then(RpcClient::take_inbound);
    let cmd_tx: Option<mpsc::Sender<Command>> = backend.as_ref().map(RpcClient::command_sender);

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
                app.footer.spinner_glyph = SPINNER_FRAMES[spinner_idx];
                app.footer.elapsed_secs = start.elapsed().as_secs();
                terminal.draw(|frame| {
                    draw_app(frame, &app);
                })?;
            }
            _ = spinner_tick.tick() => {
                spinner_idx = (spinner_idx + 1) % SPINNER_FRAMES.len();
                app.input.focus_pulse = app.input.focus_pulse.wrapping_add(8);
            }
            ev = events.next() => {
                match ev {
                    Some(Ok(CrosstermEvent::Key(key))) => {
                        let action = app.handle_key(key);
                        if matches!(action, AppAction::Quit) {
                            break;
                        }
                        // RPC commands only fire when a backend is attached.
                        // In demo mode `cmd_tx` is `None`, so AppActions that
                        // would have produced a Command silently degrade to
                        // local-only UI state changes (overlays, focus, etc.).
                        if let (Some(tx), Some(cmd)) =
                            (cmd_tx.as_ref(), App::action_to_command(&action))
                        {
                            let _ = tx.send(cmd).await;
                        }
                    }
                    Some(Ok(CrosstermEvent::Paste(text))) => {
                        // Bracketed paste: the terminal hands us the
                        // whole clipboard payload atomically. Splice
                        // it into the input buffer at the cursor as
                        // one undo-able operation; IME pastes of
                        // multi-grapheme CJK strings stay intact.
                        if matches!(app.focus, FocusMode::Input) {
                            app.input.handle_paste(&text);
                            app.refresh_autocomplete();
                        }
                    }
                    Some(Ok(CrosstermEvent::Mouse(mouse))) => {
                        app.handle_mouse(mouse);
                    }
                    _ => {}
                }
            }
            // 4th arm: drain inbound RPC frames when a backend is up.
            // The async block stays Pending forever when `inbound` is
            // None, so this arm never fires in render-only / demo mode.
            inbound_msg = async {
                match inbound.as_mut() {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending::<Option<Inbound>>().await,
                }
            } => {
                match inbound_msg {
                    Some(msg) => app.apply_inbound(msg),
                    // Channel closed: null out the receiver so future
                    // iterations skip this arm via the pending future.
                    None => inbound = None,
                }
            }
        }
    }

    // RpcClient drops here; kill_on_drop reaps the child process.
    drop(backend);
    Ok(())
}

fn draw_app(frame: &mut Frame<'_>, app: &App) {
    let area = frame.area();
    let input_wrap_width = usize::from(area.width.saturating_sub(6).max(1));
    let line_count = app.input.display_lines(input_wrap_width).len();
    // The sidebar shows demo metadata (todo list, file picker, etc.) and
    // is only wired in demo mode for now. In real `senpi --neo` runs we
    // keep the layout single-column so the chat reclaims the right edge
    // instead of leaving a blank gutter.
    let sidebar_visible = app.demo_mode && area.width >= layout::SIDEBAR_MIN_TERMINAL_WIDTH;
    let computed = layout::compute(
        area,
        LayoutState {
            input_lines: u16::try_from(line_count).unwrap_or(1),
            sidebar_visible,
        },
    );

    header::render(frame, computed.header, &app.theme, &app.header);
    chat::render(frame, computed.chat, &app.theme, &app.chat);
    input::render(frame, computed.input, &app.theme, &app.input);
    footer::render(frame, computed.footer, &app.theme, &app.footer);

    if let Some(overlay) = app.overlay.as_ref() {
        overlay.render(frame, area, &app.theme);
    } else {
        render_autocomplete_popup(frame, area, computed.input, app);
    }
}

fn render_autocomplete_popup(frame: &mut Frame<'_>, area: Rect, input_area: Rect, app: &App) {
    let Some(items) = app.autocomplete_popup.as_ref().filter(|items| !items.is_empty()) else {
        return;
    };
    let max_items = items.len().min(6);
    let height = u16::try_from(max_items).unwrap_or(6).saturating_add(2);
    let width = input_area.width.saturating_sub(4).clamp(24, 64).min(area.width);
    let x = input_area
        .x
        .saturating_add(2)
        .min(area.right().saturating_sub(width));
    let y = input_area.y.saturating_sub(height);
    let popup_area = Rect::new(x, y, width, height.min(area.height));
    let popup_items = items.iter().take(max_items).map(|item| {
        let mut spans = vec![Span::styled(
            item.label.clone(),
            Style::default().fg(app.theme.token(theme::Token::Text)),
        )];
        if let Some(description) = item.description.as_ref() {
            spans.push(Span::raw("  "));
            spans.push(Span::styled(
                description.clone(),
                Style::default().fg(app.theme.token(theme::Token::TextMuted)),
            ));
        }
        ListItem::new(Line::from(spans))
    });
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(app.theme.token(theme::Token::BorderActive)))
        .style(Style::default().bg(app.theme.token(theme::Token::BackgroundMenu)));
    let list = List::new(popup_items).block(block).highlight_style(
        Style::default()
            .fg(app.theme.token(theme::Token::SelectionFg))
            .bg(app.theme.token(theme::Token::SelectionBg))
            .add_modifier(Modifier::BOLD),
    );
    let mut state = ListState::default();
    state.select(Some(app.autocomplete_index.min(max_items.saturating_sub(1))));

    frame.render_widget(Clear, popup_area);
    frame.render_stateful_widget(list, popup_area, &mut state);
}

#[cfg(test)]
mod tests {
    use super::parse_backend_args;

    #[test]
    fn parse_backend_args_decodes_json_array() {
        let args = parse_backend_args(r#"["/path/to/cli.js","--mode","rpc"]"#);
        assert_eq!(args, vec!["/path/to/cli.js", "--mode", "rpc"]);
    }

    #[test]
    fn parse_backend_args_preserves_whitespace_in_json_values() {
        let args = parse_backend_args(r#"["--system-prompt","be terse and direct","--mode","rpc"]"#);
        assert_eq!(
            args,
            vec!["--system-prompt", "be terse and direct", "--mode", "rpc"],
        );
    }

    #[test]
    fn parse_backend_args_falls_back_to_whitespace_split() {
        let args = parse_backend_args("--mode rpc --foo bar");
        assert_eq!(args, vec!["--mode", "rpc", "--foo", "bar"]);
    }

    #[test]
    fn parse_backend_args_empty_returns_empty_vec() {
        assert!(parse_backend_args("").is_empty());
        assert!(parse_backend_args("   ").is_empty());
    }

    #[test]
    fn parse_backend_args_malformed_json_falls_back_to_whitespace() {
        let args = parse_backend_args("[\"unterminated");
        assert_eq!(args, vec!["[\"unterminated"]);
    }
}
