//! Application loop and state container.
//!
//! Owns the terminal, drives a single `tokio::select!` loop multiplexing
//! crossterm events + draw requests + inbound RPC frames, dispatches
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
    terminal::{
        BeginSynchronizedUpdate, EndSynchronizedUpdate, EnterAlternateScreen, LeaveAlternateScreen,
        disable_raw_mode, enable_raw_mode,
    },
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
    frame::FrameRequester,
    keymap::{self, FocusMode, ResolvedKeymap},
    layout::{self, LayoutState},
    overlay::{
        HelpOverlay, ModelPickerOverlay, Overlay, OverlayResult, PaletteOverlay, SlashOverlay,
        ThemePickerOverlay,
    },
    rpc::{
        client::{Inbound, RpcClient},
        command::Command,
        envelope::Response,
        event::Event as RpcEvent,
    },
    term::TerminalCaps,
    theme::{self, ResolvedTheme},
};

const SPINNER_FRAMES: [char; 8] = ['⠂', '⠆', '⠒', '⠢', '⠖', '⠲', '⠴', '⠤'];
const SPINNER_FRAME_MS: u64 = 80;

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
    /// Open the theme picker overlay (Alt+T).
    OpenThemePicker,
    /// Open the help overlay (?).
    OpenHelp,
    /// Open the command palette (Alt+P).
    OpenPalette,
    /// Cycle the active model. The wire protocol's `cycle_model` is
    /// next-only today, so this variant carries no direction. Backward
    /// cycling lands at [`App::note_unimplemented_action`] in
    /// [`App::execute_action`] until the backend grows a reverse RPC.
    CycleModel,
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
    /// Toggle the sidebar pane (Alt+S).
    ToggleSidebar,
    /// Toggle UI animations (spinners, scanners, pulses) (Alt+A).
    ToggleAnimations,
    /// Trigger backend session compaction (Alt+C).
    CompactSession,
    /// Set the backend model. Carries the parsed
    /// `(provider, model_id)` pair from the picker selection so the
    /// run loop can fire `Command::SetModel` end-to-end.
    SetModel { provider: String, model_id: String },
    /// Pop the most recent queued steering / follow-up message back
    /// into the input buffer (Alt+Up).
    DequeueMessage,
    /// Hand the input buffer to `$VISUAL` / `$EDITOR` and read the
    /// edited contents back. The run loop performs the launch + IO
    /// because the App is render-only at that point.
    ExternalEditorLaunch,
    /// Suspend the process via SIGTSTP (Ctrl+Z). The run loop
    /// restores the terminal, sends SIGTSTP to self via `kill -TSTP`,
    /// and re-initializes the TUI when the shell resumes the
    /// process via `fg`.
    Suspend,
    /// Start a fresh backend session (`/new` from slash menu, or
    /// `app.session.new` from the command palette).
    NewSession,
}

/// Stateful TUI application surface used by the run loop and behavioral
/// tests. Bundles the resolved keymap, focus mode, and every
/// per-component state struct the renderer consumes.
///
/// `#[allow(clippy::struct_excessive_bools)]`: the legacy senpi
/// keybinding contract advertises multiple independent boolean
/// toggles (`thinking_visible`, `tools_expanded`, `sidebar_visible`,
/// `animations_enabled`, `demo_mode`). Promoting these to an enum
/// would lose orthogonality - the user expects to combine them
/// freely.
#[allow(clippy::struct_excessive_bools)]
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
    /// `true` when the user has explicitly enabled the sidebar via
    /// `neo.sidebar.toggle` (Alt+S). Layout only allocates the sidebar
    /// pane when `sidebar_visible || demo_mode` AND the terminal is
    /// wide enough.
    pub sidebar_visible: bool,
    /// `true` when spinner / scanner / pulse animations should play.
    /// Toggled by `neo.toggle_animations` (Alt+A). When `false`, the
    /// footer spinner glyph stops rotating so the UI stays static
    /// (helpful for screen recordings or low-power terminals).
    pub animations_enabled: bool,
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
            sidebar_visible: false,
            animations_enabled: true,
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
        let header_cwd = PathBuf::from(&self.header.cwd);
        if header_cwd.is_absolute() {
            header_cwd
        } else {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
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
            "tui.editor.cursorUp" | "neo.input.historyPrev" => {
                if self.input.recall_prev_history().is_some() {
                    self.refresh_autocomplete();
                    return Some(AppAction::Consumed("neo.input.historyPrev".into()));
                }
                self.input.cursor_up();
            }
            "tui.editor.cursorDown" | "neo.input.historyNext" => {
                if self.input.recall_next_history().is_some() {
                    self.refresh_autocomplete();
                    return Some(AppAction::Consumed("neo.input.historyNext".into()));
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
            "tui.editor.cursorUp" | "neo.input.historyPrev" => {
                self.select_previous_autocomplete();
                Some(AppAction::Consumed("tui.autocomplete.previous".into()))
            }
            "tui.editor.cursorDown" | "neo.input.historyNext" => {
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

    /// Test-only entry point that drives [`Self::execute_action`] directly.
    /// Useful for asserting overlay-selected actions (`neo.theme.set:<id>`,
    /// `neo.model.set:<id>`) that can only flow into the dispatcher via
    /// an overlay `OverlayResult::Selected` and have no keyboard chord.
    /// `#[doc(hidden)]` keeps it out of the rendered public docs while
    /// still letting integration tests under `tests/` see it.
    #[doc(hidden)]
    #[must_use]
    pub fn execute_action_for_tests(&mut self, id: &str) -> AppAction {
        self.execute_action(id)
    }

    /// Apply a `neo.theme.set:<id>` selection emitted by the theme
    /// picker overlay. Loads the registry entry, flips `self.theme` on
    /// success, or pushes a chat error + footer error state on failure.
    /// Bug 3 contract: never let a failed theme load fall through to
    /// the catch-all silent consumer.
    fn apply_theme_selection(&mut self, action_id: &str) -> AppAction {
        let new_id = action_id.strip_prefix("neo.theme.set:").unwrap_or_default();
        match theme::load_by_id(new_id, theme::ThemeMode::Dark) {
            Ok(resolved) => {
                self.theme = resolved;
            }
            Err(err) => {
                self.chat
                    .push_error(format!("Could not load theme `{new_id}`: {err}"));
                self.footer.status = Status::Error;
                self.footer.status_label = "theme load failed".into();
            }
        }
        AppAction::Consumed(action_id.to_owned())
    }

    /// Apply a `neo.model.set:<id>` selection emitted by the model
    /// picker overlay. Round 12 / real port: actually fire the
    /// backend `Command::SetModel { provider, model_id }`. The
    /// picker only carries the model id, so we infer the provider
    /// from the id prefix via [`provider_for_model_id`]. If the
    /// provider cannot be inferred (custom model id), push a
    /// chat-system note explaining the lookup miss instead of
    /// silently consuming the selection - the user can switch via
    /// legacy `senpi` for now.
    fn apply_model_selection(&mut self, action_id: &str) -> AppAction {
        let new_id = action_id.strip_prefix("neo.model.set:").unwrap_or_default();
        let Some(provider) = provider_for_model_id(new_id) else {
            self.chat.push_system(format!(
                "Could not infer provider for model `{new_id}`. Bundled picker only knows the curated catalog; use `senpi` (without `--neo`) to select arbitrary models for now.",
            ));
            return AppAction::Consumed(action_id.to_owned());
        };
        // Reflect the pending change in header / footer immediately
        // so the user sees the chord landed. The backend will echo
        // back the canonical Model object via `set_model` response
        // (handled by `apply_model_change_response`) which
        // overwrites these placeholders with the canonical name.
        self.chat
            .push_system(format!("Switching to {provider}/{new_id}..."));
        AppAction::SetModel {
            provider: provider.to_owned(),
            model_id: new_id.to_owned(),
        }
    }

    /// Surface an advertised-but-unimplemented action to chat so the
    /// user sees that the chord landed. Bug 3 contract: silent no-ops
    /// on slash-menu / palette / hotkey-advertised actions violate the
    /// "if there is an error, say so" promise. Until the neo TUI grows
    /// real implementations for the session / tree / models actions,
    /// the explicit "not yet wired" note tells the user where to fall
    /// back.
    fn note_unimplemented_action(&mut self, action_id: &str) -> AppAction {
        self.chat.push_system(format!(
            "`{action_id}` is not yet wired in `senpi --neo`. Run `senpi` (without `--neo`) for this command.",
        ));
        AppAction::Consumed(action_id.to_owned())
    }

    /// Bug 3 (Oracle round 7): the `tui.select.*` family is bound in
    /// the bundled keymap and exposed by the command palette, but it
    /// only does useful work while an overlay is open - the
    /// compositor's `synthesise_select_event` routes those ids to the
    /// active overlay's raw handler. Selecting one from the palette
    /// when no overlay is open used to fall into the catch-all silent
    /// consume. Push a chat-system note that names the action and
    /// explains the overlay scoping so the chord is visibly accounted
    /// for. This is distinct from `note_unimplemented_action` because
    /// these actions ARE wired - just only inside an overlay.
    fn note_overlay_only_action(&mut self, action_id: &str) -> AppAction {
        self.chat.push_system(format!(
            "`{action_id}` only takes effect while an overlay (slash menu, command palette, model / theme picker, help) is open. Open an overlay first, then trigger this action.",
        ));
        AppAction::Consumed(action_id.to_owned())
    }

    fn note_session_overlay_scoped_action(&mut self, action_id: &str) -> AppAction {
        self.chat.push_system(format!(
            "`{action_id}` is a session-management action. The session overlay (open via `/tree`, `/fork`, `/resume`, or the command palette) is not yet ported to `senpi --neo`. Run `senpi` (without `--neo`) for session navigation.",
        ));
        AppAction::Consumed(action_id.to_owned())
    }

    fn note_tree_overlay_scoped_action(&mut self, action_id: &str) -> AppAction {
        self.chat.push_system(format!(
            "`{action_id}` is a session tree navigation action. The session tree overlay is not yet ported to `senpi --neo`. Run `senpi` (without `--neo`) for the `/tree` view.",
        ));
        AppAction::Consumed(action_id.to_owned())
    }

    fn note_models_overlay_scoped_action(&mut self, action_id: &str) -> AppAction {
        self.chat.push_system(format!(
            "`{action_id}` is a favorite-models management action. The favorite-models overlay is not yet ported to `senpi --neo`. Run `senpi` (without `--neo`) for the `/favorite-models` view.",
        ));
        AppAction::Consumed(action_id.to_owned())
    }

    /// Bug 3 (Oracle round 8): the raw key path at `handle_key` only
    /// opens the slash overlay when the user types `/` with an empty
    /// Input-focus buffer (so mid-prompt `/` inserts literally). When
    /// the action is dispatched THROUGH `execute_action` (the
    /// command palette path) the user explicitly chose it - the
    /// buffer-empty precondition is moot. Open the overlay
    /// unconditionally. Extracted into a helper so the dispatcher
    /// stays under clippy's per-fn line ceiling.
    fn open_slash_overlay(&mut self, action_id: &str) -> AppAction {
        self.overlay = Some(Overlay::Slash(SlashOverlay::new()));
        AppAction::Consumed(action_id.to_owned())
    }

    /// Drain the input buffer into an `AppAction::FollowUp` for the
    /// run loop to queue against the agent. Extracted from
    /// `execute_action` to keep that function under clippy's per-fn
    /// line ceiling.
    fn apply_follow_up_action(&mut self) -> AppAction {
        let text = self.input.take_buffer();
        if !text.is_empty() {
            self.input.push_history(&text);
        }
        self.clear_autocomplete();
        AppAction::FollowUp(text)
    }

    /// Drain the input buffer into an `AppAction::SubmitPrompt` and
    /// push a `Role::User` chat bubble immediately so the UI does not
    /// sit at `idle` during the LLM round-trip window. Extracted from
    /// `execute_action` to keep that function under clippy's per-fn
    /// line ceiling.
    fn apply_submit_action(&mut self) -> AppAction {
        let text = self.input.take_buffer();
        if !text.is_empty() {
            self.input.push_history(&text);
            self.chat.messages.push(Message {
                role: Role::User,
                body: text.clone(),
                tool: None,
            });
            self.footer.status = Status::Busy;
            self.footer.status_label = "waiting".into();
        }
        self.clear_autocomplete();
        AppAction::SubmitPrompt(text)
    }

    /// Bug 3 (Oracle round 8): `tui.input.tab` is bound to `tab` in
    /// the bundled keymap and exposed by the command palette. The
    /// chord IS wired - `try_autocomplete_action` handles it when an
    /// autocomplete popup is visible. But with no popup it used to
    /// fall into the catch-all silent consume. Mirror the
    /// `note_overlay_only_action` shape: push a chat-system note
    /// that names the action and explains the autocomplete-scoping
    /// so the user knows why their tab keystroke produced nothing.
    fn note_autocomplete_only_action(&mut self, action_id: &str) -> AppAction {
        self.chat.push_system(format!(
            "`{action_id}` only takes effect while an autocomplete popup is showing. Type `@` for path completion or `/` for slash commands first.",
        ));
        AppAction::Consumed(action_id.to_owned())
    }

    fn note_and_dispatch(&mut self, message: &str, action: AppAction) -> AppAction {
        self.chat.push_system(message.into());
        action
    }

    fn apply_message_dequeue(&mut self, action_id: &str) -> AppAction {
        if let Some(text) = self.chat.pop_queued_message() {
            self.input.clear();
            self.input.insert_str(&text);
            self.refresh_autocomplete();
            AppAction::DequeueMessage
        } else {
            self.chat.push_system(
                "No queued messages to dequeue. Submit a message with Enter or Alt+Enter while the agent is working to queue one.".into(),
            );
            AppAction::Consumed(action_id.to_owned())
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
            "app.exit" => AppAction::Quit,
            "app.clear" => {
                self.input.clear();
                self.clear_autocomplete();
                AppAction::Consumed(id.to_owned())
            }
            "tui.input.copy" => {
                if self.input.buffer.is_empty() {
                    AppAction::Interrupt
                } else {
                    self.input.clear();
                    self.clear_autocomplete();
                    AppAction::Consumed(id.to_owned())
                }
            }
            "app.interrupt" => AppAction::Interrupt,
            "app.model.cycleForward" => AppAction::CycleModel,
            "app.model.cycleBackward" => self.note_unimplemented_action(id),
            "app.model.select" => {
                self.overlay = Some(Overlay::ModelPicker(ModelPickerOverlay::new()));
                AppAction::OpenModelPicker
            }
            "app.suspend" => self.note_and_dispatch(
                "Suspending senpi (use `fg` in your shell to resume).",
                AppAction::Suspend,
            ),
            "app.session.new" => self.note_and_dispatch("Starting a new session...", AppAction::NewSession),
            other if is_session_overlay_scoped_action(other) => {
                self.note_session_overlay_scoped_action(other)
            }
            other if is_tree_overlay_scoped_action(other) => self.note_tree_overlay_scoped_action(other),
            other if is_models_overlay_scoped_action(other) => self.note_models_overlay_scoped_action(other),
            "neo.sidebar.toggle" => {
                self.sidebar_visible = !self.sidebar_visible;
                AppAction::ToggleSidebar
            }
            "neo.toggle_animations" => {
                self.animations_enabled = !self.animations_enabled;
                AppAction::ToggleAnimations
            }
            "neo.compact" => self.note_and_dispatch(
                "Compacting session... watch for `compaction_end` event.",
                AppAction::CompactSession,
            ),
            "app.message.dequeue" => self.apply_message_dequeue(id),
            "app.thinking.cycle" => AppAction::CycleThinkingLevel,
            "app.thinking.toggle" => {
                self.thinking_visible = !self.thinking_visible;
                AppAction::ToggleThinkingVisibility
            }
            "app.tools.expand" => {
                self.tools_expanded = !self.tools_expanded;
                AppAction::ToggleToolsExpanded
            }
            "app.editor.external" => AppAction::ExternalEditorLaunch,
            "app.message.followUp" => self.apply_follow_up_action(),
            "tui.input.submit" => self.apply_submit_action(),
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
            "neo.theme.picker" => {
                self.overlay = Some(Overlay::ThemePicker(ThemePickerOverlay::new(&self.theme.name)));
                AppAction::OpenThemePicker
            }
            "neo.slash.open" => self.open_slash_overlay(id),
            "tui.input.tab" => self.note_autocomplete_only_action(id),
            other if other.starts_with("neo.theme.set:") => self.apply_theme_selection(other),
            other if other.starts_with("neo.model.set:") => self.apply_model_selection(other),
            other if is_overlay_scoped_select_action(other) => self.note_overlay_only_action(other),
            other if is_advertised_unimplemented_action(other) => self.note_unimplemented_action(other),
            _ => AppAction::Consumed(id.to_owned()),
        }
    }

    /// Translate a finished [`AppAction`] into the RPC [`Command`] the
    /// backend should receive (if any). Returns `None` for actions
    /// that stay purely TUI-local (overlay open/close, focus toggles,
    /// quit, literal-char insertion, ...).
    ///
    /// `CycleModel` maps to `Command::CycleModel`. The wire protocol
    /// only supports forward cycling today; the backward chord
    /// (`shift+ctrl+p`) is intercepted earlier in
    /// [`Self::execute_action`] and surfaced as a "not yet wired" chat
    /// note (Bug 3, Oracle round 10).
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
            AppAction::CycleModel => Some(Command::CycleModel { id: None }),
            AppAction::CycleThinkingLevel => Some(Command::CycleThinkingLevel { id: None }),
            AppAction::OpenModelPicker => Some(Command::GetAvailableModels { id: None }),
            AppAction::SetModel { provider, model_id } => Some(Command::SetModel {
                id: None,
                provider: provider.clone(),
                model_id: model_id.clone(),
            }),
            AppAction::CompactSession => Some(Command::Compact {
                id: None,
                custom_instructions: None,
            }),
            AppAction::NewSession => Some(Command::NewSession { id: None }),
            _ => None,
        }
    }

    /// Apply a single inbound RPC frame to the app's renderable state.
    /// Streaming text accumulates in the last assistant message, tool
    /// cards land as their own messages, and footer status tracks the
    /// agent/turn lifecycle.
    ///
    /// Bug 3 contract ("if there's an error, say so"): every failure
    /// path - subprocess exit, EOF, JSON decode error, AND
    /// `Response { success: false }` - MUST surface to the chat and
    /// footer. Silent error swallowing is the original user complaint
    /// and the loudest regression vector here, so each arm below
    /// renders something.
    pub fn apply_inbound(&mut self, msg: Inbound) {
        match msg {
            Inbound::Event(event) => {
                self.footer.connected = true;
                self.apply_event(event);
            }
            Inbound::Response(response) => self.apply_response(&response),
            Inbound::Error {
                exit_code,
                stderr_tail,
            } => {
                let detail = if stderr_tail.is_empty() {
                    String::new()
                } else {
                    format!("\n\n{stderr_tail}")
                };
                let body = exit_code.map_or_else(
                    || format!("Backend exited unexpectedly.{detail}"),
                    |code| format!("Backend exited with code {code}.{detail}"),
                );
                self.chat.push_error(body);
                self.footer.status = Status::Error;
                self.footer.status_label = "backend error".into();
                self.footer.connected = false;
                self.footer.spinner_glyph = '\u{00d7}';
            }
            Inbound::Disconnected => {
                self.chat.push_system("Backend disconnected.".into());
                self.footer.status = Status::Error;
                self.footer.status_label = "disconnected".into();
                self.footer.connected = false;
            }
            Inbound::ParseError { line, source } => {
                // Protocol corruption is invisible to the user if we
                // only log to tracing - they see a stuck spinner and
                // no clue why. Push a chat error so it shows up in the
                // running terminal, and flip the footer so the status
                // glyph reflects the broken state. Also keep the
                // tracing line for stderr / log aggregation.
                tracing::warn!(line = %line, source = %source, "rpc parse error");
                let preview = line.chars().take(80).collect::<String>();
                let suffix = if line.chars().count() > 80 { "..." } else { "" };
                self.chat.push_error(format!(
                    "Backend sent unparseable JSON: {source}\n\n{preview}{suffix}"
                ));
                self.footer.status = Status::Error;
                self.footer.status_label = "protocol error".into();
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
            RpcEvent::MessageEnd { message } => {
                self.apply_message_end(&message);
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
                self.apply_message_update_delta(assistant_message_event.as_ref());
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
            RpcEvent::CompactionEnd {
                aborted,
                error_message,
                will_retry,
                ..
            } if aborted || error_message.is_some() => {
                self.apply_compaction_failure(error_message.as_deref(), will_retry);
            }
            RpcEvent::AutoRetryEnd {
                success: false,
                attempt,
                final_error,
            } => {
                self.apply_auto_retry_failure(attempt, final_error.as_deref());
            }
            RpcEvent::ExtensionUiRequest {
                method,
                message,
                notify_type,
                title,
            } => {
                self.apply_extension_ui_request(
                    &method,
                    message.as_deref(),
                    notify_type.as_deref(),
                    title.as_deref(),
                );
            }
            RpcEvent::QueueUpdate { steering, follow_up } => {
                let mut combined = steering;
                combined.extend(follow_up);
                self.chat.replace_queued_messages(combined);
            }
            _ => {}
        }
    }

    /// Append a streaming `text_delta` to the current assistant bubble,
    /// or push a fresh assistant bubble if the last message is not an
    /// assistant text block. Lazy bubble creation avoids the phantom
    /// empty `senpi` row before the real reply (see `MessageStart`).
    fn apply_message_update_delta(&mut self, event_payload: Option<&serde_json::Value>) {
        let delta = event_payload.and_then(|v| {
            let kind = v.get("type").and_then(serde_json::Value::as_str)?;
            if kind == "text_delta" {
                v.get("delta").and_then(serde_json::Value::as_str)
            } else {
                None
            }
        });
        let Some(text) = delta else {
            return;
        };
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

    /// Bug 3 (Oracle round 6): `compaction_end` previously silenced
    /// `aborted` / `error_message`. Push a chat error explaining what
    /// failed and whether the backend will retry, so the user knows
    /// whether they need to intervene.
    fn apply_compaction_failure(&mut self, error_message: Option<&str>, will_retry: bool) {
        let retry_hint = if will_retry { " (will retry)" } else { "" };
        let body = error_message.map_or_else(
            || format!("Compaction aborted{retry_hint}."),
            |err| format!("Compaction failed{retry_hint}: {err}"),
        );
        self.chat.push_error(body);
    }

    /// Bug 3 (Oracle round 6): `auto_retry_end { success: false, .. }`
    /// previously silenced the final retry failure. Push a chat error
    /// and flip the footer so the user sees the agent gave up instead
    /// of watching it quietly go idle.
    fn apply_auto_retry_failure(&mut self, attempt: u32, final_error: Option<&str>) {
        let body = final_error.map_or_else(
            || format!("Auto-retry exhausted after {attempt} attempt(s)."),
            |err| format!("Auto-retry exhausted after {attempt} attempt(s): {err}"),
        );
        self.chat.push_error(body);
        self.footer.status = Status::Error;
        self.footer.status_label = "retry exhausted".into();
    }

    /// Apply a `message_end` event. Pops the empty assistant
    /// placeholder bubble if the backend only emitted thinking
    /// deltas (no visible text or tool card) for this message - that
    /// kept a phantom empty `senpi` row from sitting in front of the
    /// real reply.
    ///
    /// Bug 3 (Oracle round 6): when the agent loop's
    /// `buildErrorAssistantMessage` ships a failed turn through
    /// `message_end`, the `message.errorMessage` field carries the
    /// provider error string. Push it as a chat error and flip the
    /// footer instead of going straight to idle.
    fn apply_message_end(&mut self, message: &serde_json::Value) {
        if let Some(last) = self.chat.messages.last()
            && matches!(last.role, Role::Assistant)
            && last.body.is_empty()
            && last.tool.is_none()
        {
            self.chat.messages.pop();
        }
        let err = message
            .get("errorMessage")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty());
        if let Some(err) = err {
            self.chat.push_error(err.to_owned());
            self.footer.status = Status::Error;
            self.footer.status_label = "assistant error".into();
        } else {
            self.footer.status = Status::Idle;
            self.footer.status_label = "idle".into();
        }
    }

    /// Route an inbound RPC `Response` envelope. Splits cleanly into a
    /// failure path (already a Bug-3 surface as of Oracle round 2) and
    /// a success path. The success path used to silently drop the
    /// `data` payload, so `cycle_model` / `cycle_thinking_level`
    /// commands fired but the user saw no model or thinking change
    /// (Bug 3 leak flagged by Oracle round 10). Now successful
    /// responses route through command-specific handlers that update
    /// header + footer state AND push a chat note.
    fn apply_response(&mut self, response: &Response) {
        if !response.success {
            let body = response.error.as_deref().map_or_else(
                || format!("Backend reported `{}` failed.", response.command),
                |err| format!("`{}` failed: {err}", response.command),
            );
            self.chat.push_error(body);
            self.footer.status = Status::Error;
            self.footer.status_label = "command failed".into();
            return;
        }
        match response.command.as_str() {
            "cycle_model" | "set_model" => self.apply_model_change_response(response),
            "cycle_thinking_level" | "set_thinking_level" => {
                self.apply_thinking_change_response(response);
            }
            // Other commands (`prompt`, `abort`, `new_session`,
            // `get_state`, `get_available_models`, `get_session_stats`,
            // ...) are acks without user-visible state changes the
            // chat needs to broadcast. Keep them silent so the
            // `app_inbound_successful_response_does_not_disturb_chat_or_footer`
            // contract holds.
            _ => {}
        }
    }

    /// Surface a successful `cycle_model` / `set_model` response.
    /// `cycle_model` data is `ModelCycleResult { model, thinkingLevel,
    /// isScoped, ... }` (or `null` if no other model is available),
    /// while `set_model` data is the picked Model directly. Try both
    /// shapes so the same arm handles both commands.
    fn apply_model_change_response(&mut self, response: &Response) {
        let Some(data) = response.data.as_ref() else {
            if response.command == "cycle_model" {
                self.chat.push_system(
                    "No other model is configured to cycle to. Open the model picker (`Ctrl+L`) or run `senpi` (without `--neo`) to add favorites.".into(),
                );
            }
            return;
        };
        // cycle_model nests the Model under `model`; set_model returns
        // the Model directly.
        let model_obj = data.get("model").unwrap_or(data);
        let name = model_obj
            .get("name")
            .and_then(serde_json::Value::as_str)
            .or_else(|| model_obj.get("id").and_then(serde_json::Value::as_str));
        let Some(name) = name else {
            return;
        };
        let provider = model_obj.get("provider").and_then(serde_json::Value::as_str);
        let display = provider.map_or_else(|| name.to_owned(), |provider| format!("{provider}/{name}"));
        self.header.model.clone_from(&display);
        self.footer.model.clone_from(&display);
        self.chat.push_system(format!("Model: {display}"));
    }

    /// Bug 3 (Oracle round 11): extensions emit
    /// `extension_ui_request` frames for user-facing notifications
    /// (`notify`) and modal dialogs (`select`, `confirm`, `input`,
    /// `editor`). The old `apply_event` catch-all matched these as
    /// [`RpcEvent::Other`] and silently discarded the message, so
    /// extension warnings ("Command blocked", "Path denied", ...)
    /// never reached chat. Surface each method:
    /// - `notify` → push the message (`Role::Error` for
    ///   `notifyType: "error"`, `Role::System` otherwise) and flip the
    ///   footer status on error.
    /// - Dialog methods → push a "not yet wired" chat note naming the
    ///   method + title so the user sees the request landed. The
    ///   backend's per-request timeout (or `ctx.hasUI` semantics)
    ///   auto-resolves these; future dialog overlay work will replace
    ///   the note with a real picker / prompt.
    /// - Per-extension UI updates (`setStatus`, `setWidget`,
    ///   `setTitle`, `set_editor_text`) stay silent because they are
    ///   not user-facing errors and would otherwise flood chat.
    fn apply_extension_ui_request(
        &mut self,
        method: &str,
        message: Option<&str>,
        notify_type: Option<&str>,
        title: Option<&str>,
    ) {
        match method {
            "notify" => {
                let body = message.unwrap_or("(empty notification)");
                if matches!(notify_type, Some("error")) {
                    self.chat.push_error(format!("Extension: {body}"));
                    self.footer.status = Status::Error;
                    self.footer.status_label = "extension error".into();
                } else {
                    self.chat.push_system(format!("Extension: {body}"));
                }
            }
            "select" | "confirm" | "input" | "editor" => {
                let header = title.or(message).unwrap_or("(no title)");
                self.chat.push_system(format!(
                    "Extension dialog (`{method}`, title: \"{header}\") is not yet wired in `senpi --neo`. Run `senpi` (without `--neo`) for interactive extensions; the request will auto-resolve when the backend's timeout fires.",
                ));
            }
            // setStatus / setWidget / setTitle / set_editor_text are
            // per-extension UI updates, not user-facing errors. Keeping
            // them silent matches the
            // `app_inbound_successful_response_does_not_disturb_chat_or_footer`
            // contract for protocol acks.
            _ => {}
        }
    }

    /// Surface a successful `cycle_thinking_level` / `set_thinking_level`
    /// response. `cycle_thinking_level` data is `{ level }` (or
    /// `null` if there is no other level), while `set_thinking_level`
    /// emits no data (just the success ack), so a missing `level`
    /// field is a noop for that command.
    fn apply_thinking_change_response(&mut self, response: &Response) {
        let Some(data) = response.data.as_ref() else {
            if response.command == "cycle_thinking_level" {
                self.chat
                    .push_system("No other thinking level is configured to cycle to.".into());
            }
            return;
        };
        let Some(level) = data.get("level").and_then(serde_json::Value::as_str) else {
            return;
        };
        self.header.thinking_level = Some(level.to_owned());
        self.footer.thinking = Some(level.to_owned());
        self.chat.push_system(format!("Thinking level: {level}"));
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
            sidebar_visible: false,
            animations_enabled: true,
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

/// Action ids that the bundled keymap + slash menu + command palette
/// advertise but the neo TUI does not yet implement end-to-end. The
/// legacy senpi TUI implements all of these; the rewrite has not
/// caught up yet. Without an explicit list the catch-all in
/// `execute_action` silently consumed them, which violates Bug 3.
/// Listing them here lets the dispatcher show a one-line chat
/// notification ("not yet wired") so the user sees that the chord
/// landed and knows where to fall back.
const ADVERTISED_BUT_UNIMPLEMENTED_ACTIONS: &[&str] = &["app.clipboard.pasteImage"];

fn is_advertised_unimplemented_action(id: &str) -> bool {
    ADVERTISED_BUT_UNIMPLEMENTED_ACTIONS.contains(&id)
}

const SESSION_OVERLAY_SCOPED_ACTIONS: &[&str] = &[
    "app.session.tree",
    "app.session.fork",
    "app.session.resume",
    "app.session.rename",
    "app.session.delete",
    "app.session.deleteNoninvasive",
    "app.session.togglePath",
    "app.session.toggleSort",
    "app.session.toggleNamedFilter",
];

fn is_session_overlay_scoped_action(id: &str) -> bool {
    SESSION_OVERLAY_SCOPED_ACTIONS.contains(&id)
}

const TREE_OVERLAY_SCOPED_ACTIONS: &[&str] = &[
    "app.tree.foldOrUp",
    "app.tree.unfoldOrDown",
    "app.tree.editLabel",
    "app.tree.toggleLabelTimestamp",
    "app.tree.filter.default",
    "app.tree.filter.noTools",
    "app.tree.filter.userOnly",
    "app.tree.filter.labeledOnly",
    "app.tree.filter.all",
    "app.tree.filter.cycleForward",
    "app.tree.filter.cycleBackward",
];

fn is_tree_overlay_scoped_action(id: &str) -> bool {
    TREE_OVERLAY_SCOPED_ACTIONS.contains(&id)
}

const MODELS_OVERLAY_SCOPED_ACTIONS: &[&str] = &[
    "app.models.save",
    "app.models.toggleFavorite",
    "app.models.enableAll",
    "app.models.clearAll",
    "app.models.toggleProvider",
    "app.models.reorderUp",
    "app.models.reorderDown",
];

fn is_models_overlay_scoped_action(id: &str) -> bool {
    MODELS_OVERLAY_SCOPED_ACTIONS.contains(&id)
}

/// Infer the backend `provider` for a curated model id.
///
/// The bundled picker only carries model ids (no provider prefix),
/// but `Command::SetModel` requires both. Returns `None` for unknown
/// / custom model ids; the caller surfaces that to the chat instead
/// of firing a malformed command.
///
/// This is intentionally a small static lookup keyed on the prefix
/// pattern. Future iterations can replace it with a backend round-trip
/// via `get_available_models` (Round 12 / real port).
#[must_use]
pub fn provider_for_model_id(model_id: &str) -> Option<&'static str> {
    if model_id.starts_with("claude-") {
        Some("anthropic")
    } else if model_id.starts_with("gpt-") {
        Some("openai")
    } else if model_id.starts_with("kimi-") {
        Some("kimi-for-coding")
    } else if model_id.starts_with("glm-") {
        Some("opencode-zen")
    } else if model_id.starts_with("deepseek") {
        Some("deepseek")
    } else if model_id.starts_with("gemini-") {
        Some("google")
    } else {
        None
    }
}

/// `tui.select.*` action ids that the bundled keymap + command
/// palette advertise but that only take effect when an overlay's raw
/// handler is consuming the synthetic key (see
/// `synthesise_select_event`). Selecting one from the palette when no
/// overlay is open used to be a silent no-op (Bug 3, Oracle round 7);
/// listing them here lets the dispatcher push an explanatory chat
/// note via [`App::note_overlay_only_action`] instead of dropping
/// into the catch-all.
const OVERLAY_SCOPED_SELECT_ACTIONS: &[&str] = &[
    "tui.select.up",
    "tui.select.down",
    "tui.select.pageUp",
    "tui.select.pageDown",
    "tui.select.confirm",
    "tui.select.cancel",
];

fn is_overlay_scoped_select_action(id: &str) -> bool {
    OVERLAY_SCOPED_SELECT_ACTIONS.contains(&id)
}

/// Round 12 / real port: suspend the TUI, hand the input buffer to
/// `$VISUAL` (or `$EDITOR`, falling back to `vi`), read the edited
/// result back, and restore the TUI. The buffer is written to a temp
/// file in `std::env::temp_dir()` named with a millisecond timestamp
/// so concurrent edits do not collide. The editor inherits stdio so
/// the user sees and interacts with it directly.
async fn run_external_editor(terminal: &mut Terminal<CrosstermBackend<Stdout>>, app: &mut App) -> Result<()> {
    use std::{
        fs,
        io::ErrorKind,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::process::Command as TokioCommand;

    let editor = std::env::var_os("VISUAL")
        .or_else(|| std::env::var_os("EDITOR"))
        .unwrap_or_else(|| "vi".into());

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let mut path = std::env::temp_dir();
    path.push(format!("senpi-neo-editor-{stamp}.md"));
    fs::write(&path, app.input.buffer.as_bytes())?;

    // Suspend the TUI so the editor sees a clean terminal.
    let caps = TerminalCaps::detect();
    disable_raw_mode()?;
    let _ = execute!(std::io::stdout(), PopKeyboardEnhancementFlags);
    let _ = execute!(std::io::stdout(), DisableBracketedPaste);
    execute!(std::io::stdout(), LeaveAlternateScreen, DisableMouseCapture)?;
    let _ = write_terminal_bytes(&caps.cleanup_writes());

    let status_result = TokioCommand::new(&editor).arg(&path).status().await;

    // Restore the TUI regardless of the editor's exit status so a
    // crashed editor does not leave the user in a half-broken
    // terminal.
    write_terminal_bytes(&caps.init_writes())?;
    enable_raw_mode()?;
    execute!(std::io::stdout(), EnterAlternateScreen, EnableMouseCapture)?;
    let _ = execute!(std::io::stdout(), EnableBracketedPaste);
    let _ = execute!(
        std::io::stdout(),
        PushKeyboardEnhancementFlags(caps.kitty_keyboard_flags),
    );
    terminal.clear()?;

    let status = status_result?;
    if !status.success() {
        // Best-effort cleanup; ignore failures so the user still
        // gets editor feedback.
        let _ = fs::remove_file(&path);
        return Err(color_eyre::eyre::eyre!(
            "$VISUAL / $EDITOR exited with status {status}",
        ));
    }

    let edited = fs::read_to_string(&path)?;
    let trimmed = edited.trim_end_matches('\n').to_owned();
    app.input.clear();
    app.input.insert_str(&trimmed);
    app.refresh_autocomplete();

    if let Err(err) = fs::remove_file(&path) {
        if err.kind() != ErrorKind::NotFound {
            tracing::warn!(path = %path.display(), error = %err, "failed to remove editor temp file");
        }
    }

    Ok(())
}

/// Round 13 / extended port: suspend the process via SIGTSTP so the
/// user's shell catches it as a stopped job. Restore the terminal
/// first so the shell prompt does not inherit raw mode + alt screen.
/// Re-initializes the terminal after `fg` resumes the process.
///
/// On non-Unix platforms (Windows), SIGTSTP does not exist; surface a
/// friendly error instead of stopping the process in a broken way.
#[allow(clippy::unused_async)] // tokio scope alignment with siblings
async fn run_suspend(terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> Result<()> {
    #[cfg(unix)]
    {
        use std::process::Command as StdCommand;

        let caps = TerminalCaps::detect();
        disable_raw_mode()?;
        let _ = execute!(std::io::stdout(), PopKeyboardEnhancementFlags);
        let _ = execute!(std::io::stdout(), DisableBracketedPaste);
        execute!(std::io::stdout(), LeaveAlternateScreen, DisableMouseCapture)?;
        let _ = write_terminal_bytes(&caps.cleanup_writes());

        let pid = std::process::id().to_string();
        let status = StdCommand::new("kill").args(["-TSTP", &pid]).status();

        // After `fg`, the process continues here. Restore the TUI
        // regardless of whether `kill` actually delivered the
        // signal so a kill-binary-missing system does not strand
        // the user in a broken terminal.
        write_terminal_bytes(&caps.init_writes())?;
        enable_raw_mode()?;
        execute!(std::io::stdout(), EnterAlternateScreen, EnableMouseCapture)?;
        let _ = execute!(std::io::stdout(), EnableBracketedPaste);
        let _ = execute!(
            std::io::stdout(),
            PushKeyboardEnhancementFlags(caps.kitty_keyboard_flags),
        );
        terminal.clear()?;

        match status {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(color_eyre::eyre::eyre!("kill -TSTP exited with status {s}",)),
            Err(err) => Err(color_eyre::eyre::eyre!("could not invoke `kill`: {err}")),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = terminal;
        Err(color_eyre::eyre::eyre!(
            "Ctrl+Z / SIGTSTP suspend is Unix-only; senpi --neo cannot suspend itself on this platform",
        ))
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
/// (e.g. `--system-prompt "..."`) survive intact.
///
/// Returns one of:
/// - `Ok(None)`: env unset; the TUI runs in render-only mode (demos,
///   screenshots, unit tests).
/// - `Ok(Some(client))`: backend booted successfully.
/// - `Err(message)`: env was set but the spawn failed. The caller MUST
///   surface this to the user; previously the failure was silently
///   collapsed to `None` and the user saw the same UI as a demo run
///   (Bug 3 leak flagged by Oracle round 2 + 4).
fn maybe_spawn_backend() -> Result<Option<RpcClient>, String> {
    let Some(bin) = std::env::var_os("SENPI_NEO_BACKEND_BIN") else {
        return Ok(None);
    };
    let args = parse_backend_args(&std::env::var("SENPI_NEO_BACKEND_ARGS").unwrap_or_default());
    match RpcClient::spawn(&bin, &args) {
        Ok(client) => Ok(Some(client)),
        Err(err) => Err(format!(
            "failed to launch senpi backend binary `{}`: {err}",
            std::path::Path::new(&bin).display(),
        )),
    }
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

/// Outcome of one `EventStream::next()` poll, surfaced from
/// [`handle_terminal_event`] so [`drive`] stays under clippy's
/// per-fn line ceiling without losing readability.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TerminalEventOutcome {
    Continue,
    Quit,
    Disconnected,
    BackendChannelClosed,
    /// Round 12 / real port: user invoked `app.editor.external`
    /// (Ctrl+G). The run loop must suspend the TUI, spawn
    /// `$VISUAL` / `$EDITOR` against the current input buffer, read
    /// the edited result back, and restore the TUI.
    ExternalEditor,
    /// Round 13 / extended port: user invoked `app.suspend`
    /// (Ctrl+Z). The run loop restores the terminal, sends
    /// SIGTSTP to self, and re-initializes the TUI when the shell
    /// resumes the process via `fg`.
    Suspend,
}

async fn handle_terminal_event(
    app: &mut App,
    cmd_tx: Option<&mpsc::Sender<Command>>,
    demo_mode: bool,
    ev: Option<Result<CrosstermEvent, std::io::Error>>,
) -> TerminalEventOutcome {
    match ev {
        Some(Ok(CrosstermEvent::Key(key))) => {
            let action = app.handle_key(key);
            if matches!(action, AppAction::Quit) {
                return TerminalEventOutcome::Quit;
            }
            if matches!(action, AppAction::ExternalEditorLaunch) {
                return TerminalEventOutcome::ExternalEditor;
            }
            if matches!(action, AppAction::Suspend) {
                return TerminalEventOutcome::Suspend;
            }
            // RPC commands only fire when a backend is attached. In
            // demo mode `cmd_tx` is `None`, so AppActions that would
            // have produced a Command silently degrade to local-only
            // UI state changes (overlays, focus, etc.).
            if let Some(cmd) = App::action_to_command(&action) {
                if let Some(tx) = cmd_tx {
                    if tx.send(cmd).await.is_err() {
                        return TerminalEventOutcome::BackendChannelClosed;
                    }
                } else if !demo_mode {
                    app.apply_inbound(Inbound::Error {
                        exit_code: None,
                        stderr_tail: "No backend process is connected.".into(),
                    });
                }
            }
            TerminalEventOutcome::Continue
        }
        Some(Ok(CrosstermEvent::Paste(text))) => {
            // Bracketed paste: the terminal hands us the whole
            // clipboard payload atomically. Splice it into the input
            // buffer as one undo-able operation; IME pastes of
            // multi-grapheme CJK strings stay intact.
            if matches!(app.focus, FocusMode::Input) {
                app.input.handle_paste(&text);
                app.refresh_autocomplete();
            }
            TerminalEventOutcome::Continue
        }
        Some(Ok(CrosstermEvent::Mouse(mouse))) => {
            app.handle_mouse(mouse);
            TerminalEventOutcome::Continue
        }
        Some(Err(err)) => {
            // Bug 3 (Oracle round 6): a `Some(Err(_))` from
            // `EventStream` means the terminal-input pipe hit an I/O
            // failure - keystrokes will not be landing any more.
            // Surface it so the user knows why the TUI suddenly
            // stopped reacting instead of getting a silent freeze.
            app.apply_inbound(Inbound::Error {
                exit_code: None,
                stderr_tail: format!("terminal input stream error: {err}"),
            });
            TerminalEventOutcome::Continue
        }
        Some(Ok(_)) => TerminalEventOutcome::Continue,
        None => {
            // Stream exhausted - the TTY closed. Without an explicit
            // break the loop would spin because `Poll::Ready(None)`
            // is always immediate.
            app.apply_inbound(Inbound::Disconnected);
            TerminalEventOutcome::Disconnected
        }
    }
}

async fn drive(terminal: &mut Terminal<CrosstermBackend<Stdout>>, config: AppConfig) -> Result<()> {
    let demo_mode = config.demo_mode;
    let demo_seconds = config.demo_seconds;
    let mut app = App::from_config(config)?;

    // Demo mode keeps the loop pure-render so screenshots and tests
    // do not require a backend on the host. Production paths set
    // SENPI_NEO_BACKEND_BIN to either senpi --mode rpc or the QA
    // harness's senpi-neo-faux binary.
    let mut backend: Option<RpcClient> = None;
    if !demo_mode {
        match maybe_spawn_backend() {
            Ok(client) => backend = client,
            Err(message) => {
                // Bug 3 contract: an env-configured-but-unspawnable
                // backend used to boot identically to demo mode. Now
                // the user sees the actual spawn failure as soon as the
                // first frame renders.
                app.apply_inbound(Inbound::Error {
                    exit_code: None,
                    stderr_tail: message,
                });
            }
        }
    }
    let mut inbound: Option<mpsc::Receiver<Inbound>> = backend.as_mut().and_then(RpcClient::take_inbound);
    let cmd_tx: Option<mpsc::Sender<Command>> = backend.as_ref().map(RpcClient::command_sender);

    let mut events = EventStream::new();
    let mut spinner_tick = interval(Duration::from_millis(SPINNER_FRAME_MS));
    spinner_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let start = Instant::now();
    let mut spinner_idx: usize = 0;
    let demo_deadline = demo_seconds.map(|s| start + Duration::from_secs(s));
    let (draw_tx, _) = tokio::sync::broadcast::channel::<()>(16);
    let frame_requester = FrameRequester::new(draw_tx.clone());
    let mut draw_rx = draw_tx.subscribe();
    frame_requester.schedule_frame();

    loop {
        if let Some(deadline) = demo_deadline {
            if Instant::now() >= deadline {
                break;
            }
        }

        tokio::select! {
            biased;
            _ = draw_rx.recv() => {
                app.footer.spinner_glyph = SPINNER_FRAMES[spinner_idx];
                app.footer.elapsed_secs = start.elapsed().as_secs();
                let stdout_handle = terminal.backend_mut();
                execute!(stdout_handle, BeginSynchronizedUpdate)?;
                terminal.draw(|frame| draw_app(frame, &app))?;
                execute!(terminal.backend_mut(), EndSynchronizedUpdate)?;
            }
            _ = spinner_tick.tick() => {
                if app.animations_enabled {
                    spinner_idx = (spinner_idx + 1) % SPINNER_FRAMES.len();
                    app.input.focus_pulse = app.input.focus_pulse.wrapping_add(8);
                    frame_requester.schedule_frame();
                }
            }
            ev = events.next() => {
                let outcome = handle_terminal_event(&mut app, cmd_tx.as_ref(), demo_mode, ev).await;
                match outcome {
                    TerminalEventOutcome::Continue => {}
                    TerminalEventOutcome::Quit | TerminalEventOutcome::Disconnected => break,
                    TerminalEventOutcome::ExternalEditor => {
                        if let Err(err) = run_external_editor(terminal, &mut app).await {
                            app.apply_inbound(Inbound::Error {
                                exit_code: None,
                                stderr_tail: format!("external editor failed: {err}"),
                            });
                        }
                    }
                    TerminalEventOutcome::Suspend => {
                        if let Err(err) = run_suspend(terminal).await {
                            app.apply_inbound(Inbound::Error {
                                exit_code: None,
                                stderr_tail: format!("suspend failed: {err}"),
                            });
                        }
                    }
                    TerminalEventOutcome::BackendChannelClosed => {
                        app.apply_inbound(Inbound::Disconnected);
                        inbound = None;
                    }
                }
                frame_requester.schedule_frame();
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
                    Some(msg) => {
                        app.apply_inbound(msg);
                        frame_requester.schedule_frame();
                    }
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
    let sidebar_visible =
        (app.demo_mode || app.sidebar_visible) && area.width >= layout::SIDEBAR_MIN_TERMINAL_WIDTH;
    let computed = layout::compute(
        area,
        LayoutState {
            input_lines: u16::try_from(line_count).unwrap_or(1),
            sidebar_visible,
        },
    );

    header::render(frame, computed.header, &app.theme, &app.header);
    chat::render(
        frame,
        computed.chat,
        &app.theme,
        &app.chat,
        chat::ChatViewOpts {
            thinking_visible: app.thinking_visible,
            tools_expanded: app.tools_expanded,
        },
    );
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
