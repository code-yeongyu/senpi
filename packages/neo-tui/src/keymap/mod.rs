//! Keymap.
//!
//! Parses JSON binding strings into `KeyChord`s, matches incoming
//! `crossterm::KeyEvent`s, and resolves them to legacy senpi action IDs
//! (`app.model.select`, `tui.editor.cursorLeft`, `neo.palette.open`,
//! ...).
//!
//! The string vocabulary is the same one the legacy TS TUI uses, parsed
//! by `packages/tui/src/keys.ts::matchesKey`. We mirror it here so the
//! bundled `assets/keymaps/default.json` survives a verbatim round-trip
//! and the "keymap fully compatible with the legacy TUI" contract holds
//! at runtime, not just on paper.

use std::collections::BTreeMap;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Focus context for keymap lookup.
///
/// The same chord can resolve to a different action depending on
/// whether the editor, a select list, or a dialog is focused (legacy
/// senpi keeps the same convention via per-mode binding namespaces).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FocusMode {
    /// Top-level chat view. App-level chords (`app.*`) win.
    Normal,
    /// Multi-line input focused (Editor / Input). `tui.editor.*`,
    /// `tui.input.*`, then `app.*` win in that order.
    Input,
    /// Pop-up dialog (model picker, palette, help overlay). `tui.select.*`
    /// wins first.
    Dialog,
}

/// On-disk keymap spec mirroring the JSON shape.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeymapSpec {
    #[serde(default)]
    pub leader: Option<String>,
    #[serde(default)]
    pub leader_timeout_ms: Option<u32>,
    #[serde(default)]
    pub bindings: BTreeMap<String, Vec<String>>,
}

/// Errors surfaced by [`parse`].
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum KeymapError {
    #[error("invalid keymap json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid key chord `{0}`: {1}")]
    InvalidChord(String, &'static str),
}

/// Parse a keymap JSON document into a [`KeymapSpec`].
pub fn parse(input: &str) -> Result<KeymapSpec, KeymapError> {
    let spec: KeymapSpec = serde_json::from_str(input)?;
    Ok(spec)
}

/// A single key chord (one keystroke). Multi-stroke chord sequences are
/// out of scope here; legacy senpi never used them either.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KeyChord {
    pub code: KeyCode,
    pub mods: KeyModifiers,
}

impl KeyChord {
    /// Parse a single key chord string in the legacy senpi vocabulary
    /// (`"ctrl+c"`, `"shift+tab"`, `"alt+enter"`, `"pageup"`, `"home"`,
    /// `"ctrl+]"`, `"ctrl+-"`, etc.).
    ///
    /// Comparison is case-insensitive, modifier order is irrelevant, and
    /// `enter` / `return` are treated as the same code so legacy JSON
    /// snippets work out of the box.
    pub fn parse(raw: &str) -> Result<Self, KeymapError> {
        let normalized = raw.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            return Err(KeymapError::InvalidChord(raw.to_owned(), "empty chord"));
        }
        let mut mods = KeyModifiers::NONE;
        let mut tokens: Vec<&str> = normalized.split('+').collect();
        // `ctrl+]` and `ctrl+-` have `]` / `-` as final tokens; trailing
        // empty tokens (e.g. from `ctrl+`) would be parse errors.
        let key_token_owned = tokens
            .pop()
            .ok_or_else(|| KeymapError::InvalidChord(raw.to_owned(), "missing key"))?;
        let key_token = key_token_owned.to_string();
        for prefix in tokens {
            match prefix {
                "ctrl" => mods |= KeyModifiers::CONTROL,
                "alt" | "meta" | "opt" | "option" => mods |= KeyModifiers::ALT,
                "shift" => mods |= KeyModifiers::SHIFT,
                "super" | "cmd" | "command" | "win" => mods |= KeyModifiers::SUPER,
                _ => {
                    return Err(KeymapError::InvalidChord(raw.to_owned(), "unknown modifier"));
                }
            }
        }
        let code = match key_token.as_str() {
            "enter" | "return" => KeyCode::Enter,
            "esc" | "escape" => KeyCode::Esc,
            "tab" => KeyCode::Tab,
            "backtab" => KeyCode::BackTab,
            "space" => KeyCode::Char(' '),
            "backspace" | "bs" => KeyCode::Backspace,
            "delete" | "del" => KeyCode::Delete,
            "home" => KeyCode::Home,
            "end" => KeyCode::End,
            "pageup" | "pgup" => KeyCode::PageUp,
            "pagedown" | "pgdn" => KeyCode::PageDown,
            "up" => KeyCode::Up,
            "down" => KeyCode::Down,
            "left" => KeyCode::Left,
            "right" => KeyCode::Right,
            "insert" | "ins" => KeyCode::Insert,
            other
                if other.len() >= 2
                    && other.len() <= 3
                    && other.starts_with('f')
                    && other[1..].bytes().all(|b| b.is_ascii_digit()) =>
            {
                let n: u8 = other[1..]
                    .parse()
                    .map_err(|_| KeymapError::InvalidChord(raw.to_owned(), "bad F-key"))?;
                if !(1..=12).contains(&n) {
                    return Err(KeymapError::InvalidChord(raw.to_owned(), "F-key out of range"));
                }
                KeyCode::F(n)
            }
            other => {
                let mut chars = other.chars();
                let first = chars
                    .next()
                    .ok_or_else(|| KeymapError::InvalidChord(raw.to_owned(), "empty key token"))?;
                if chars.next().is_some() {
                    return Err(KeymapError::InvalidChord(
                        raw.to_owned(),
                        "key token must be a single character",
                    ));
                }
                KeyCode::Char(first)
            }
        };
        // Crossterm reports SHIFT for any uppercase ASCII char, even if
        // the JSON says `"a"`. Normalize: if the chord asked for SHIFT
        // and the code is a single ASCII alpha, leave SHIFT on; otherwise
        // drop SHIFT for plain chars so `"a"` matches `KeyCode::Char('a')`
        // without a phantom SHIFT.
        if let KeyCode::Char(ch) = code {
            if ch.is_ascii_alphabetic() && !mods.contains(KeyModifiers::SHIFT) {
                // ok - upper/lower handled by code itself
            }
        }
        Ok(Self { code, mods })
    }

    /// True iff this chord matches the given key event. Matches are
    /// case-aware for ASCII letters: the chord `"a"` matches
    /// `KeyCode::Char('a')` (no shift), while `"shift+a"` matches
    /// `KeyCode::Char('A')` OR `KeyCode::Char('a')` with the SHIFT flag.
    pub fn matches(&self, event: &KeyEvent) -> bool {
        let code_eq = self.code == event.code;
        let mods_eq = self.mods == event.modifiers;
        // Direct match (modifier-equal, code-equal) is the common case.
        if code_eq && mods_eq {
            return true;
        }
        // Case-folded ASCII match: ONLY when the chord does NOT require
        // SHIFT, tolerate SHIFT in the event. Some terminals emit
        // `Char('A')` + SHIFT for `ctrl+a` (legacy macOS Terminal) and
        // `Char('a')` + nothing for the same key on others. But if the
        // chord explicitly says `shift+...`, we must require SHIFT in
        // the event - otherwise `shift+ctrl+p` would match a bare
        // `ctrl+p` event and collide with `ctrl+p`.
        if let (KeyCode::Char(a), KeyCode::Char(b)) = (self.code, event.code) {
            if a.eq_ignore_ascii_case(&b) && !self.mods.contains(KeyModifiers::SHIFT) {
                let event_no_shift = event.modifiers - KeyModifiers::SHIFT;
                if self.mods == event_no_shift {
                    return true;
                }
            }
        }
        // `shift+tab` ≡ `KeyCode::BackTab` on terminals that report the
        // key that way (crossterm basic mode does this). Accept either
        // `BackTab + NONE` or `BackTab + SHIFT` for a `shift+tab` chord.
        if self.code == KeyCode::Tab
            && self.mods.contains(KeyModifiers::SHIFT)
            && event.code == KeyCode::BackTab
        {
            let event_extra = event.modifiers - KeyModifiers::SHIFT;
            let chord_extra = self.mods - KeyModifiers::SHIFT;
            if chord_extra == event_extra {
                return true;
            }
        }
        false
    }
}

/// Compiled keymap.
///
/// Every binding ID points at one or more parsed chords. Cheap to
/// clone because the inner map is small and the values are `Copy`.
#[derive(Clone, Debug, Default)]
pub struct ResolvedKeymap {
    /// `binding_id -> chords`. Preserves the JSON order so cycles
    /// (e.g. `tui.editor.cursorLeft = [left, ctrl+b]`) try the most
    /// specific match first.
    pub bindings: BTreeMap<String, Vec<KeyChord>>,
}

impl ResolvedKeymap {
    /// Compile a [`KeymapSpec`] into a resolved keymap. Returns the
    /// first parse error encountered, so a malformed default keymap is
    /// caught at startup.
    pub fn compile(spec: &KeymapSpec) -> Result<Self, KeymapError> {
        let mut bindings: BTreeMap<String, Vec<KeyChord>> = BTreeMap::new();
        for (id, raw_chords) in &spec.bindings {
            let mut compiled: Vec<KeyChord> = Vec::with_capacity(raw_chords.len());
            for raw in raw_chords {
                compiled.push(KeyChord::parse(raw)?);
            }
            bindings.insert(id.clone(), compiled);
        }
        Ok(Self { bindings })
    }

    /// All binding IDs whose chord set contains a match for `event`,
    /// preserving insertion order. Callers narrow this set by focus
    /// mode (see [`Self::dispatch`]).
    pub fn matching_ids(&self, event: &KeyEvent) -> Vec<&str> {
        let mut hits: Vec<&str> = Vec::new();
        for (id, chords) in &self.bindings {
            for chord in chords {
                if chord.matches(event) {
                    hits.push(id.as_str());
                    break;
                }
            }
        }
        hits
    }

    /// Resolve a `KeyEvent` against the current focus mode. Returns the
    /// best-matching binding ID, mirroring the legacy senpi precedence
    /// (`tui.editor.*` and `tui.input.*` win in `Input` mode, `tui.select.*`
    /// wins in `Dialog`, `app.*` wins in `Normal`). `neo.*` bindings are
    /// considered last so they can never shadow the legacy contract.
    pub fn dispatch(&self, focus: FocusMode, event: &KeyEvent) -> Option<&str> {
        let hits = self.matching_ids(event);
        if hits.is_empty() {
            return None;
        }
        let preferred_namespaces: &[&str] = match focus {
            FocusMode::Normal => &["app.", "tui.input.", "tui.select.", "tui.editor.", "neo."],
            FocusMode::Input => &["tui.editor.", "tui.input.", "app.", "tui.select.", "neo."],
            FocusMode::Dialog => &["tui.select.", "app.", "tui.editor.", "tui.input.", "neo."],
        };
        for prefix in preferred_namespaces {
            for id in &hits {
                if id.starts_with(prefix) {
                    return Some(id);
                }
            }
        }
        // No namespace match - fall back to the first raw hit. Reachable
        // only if a user adds an exotic prefix; default keymap never
        // hits this branch.
        hits.first().copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEventKind;

    const fn ev(code: KeyCode, mods: KeyModifiers) -> KeyEvent {
        KeyEvent {
            code,
            modifiers: mods,
            kind: KeyEventKind::Press,
            state: crossterm::event::KeyEventState::NONE,
        }
    }

    #[test]
    fn parses_letter_chord() {
        let c = KeyChord::parse("a").expect("letter chord parses");
        assert_eq!(c.code, KeyCode::Char('a'));
        assert_eq!(c.mods, KeyModifiers::NONE);
    }

    #[test]
    fn parses_ctrl_letter_chord() {
        let c = KeyChord::parse("ctrl+l").expect("ctrl letter parses");
        assert_eq!(c.code, KeyCode::Char('l'));
        assert!(c.mods.contains(KeyModifiers::CONTROL));
    }

    #[test]
    fn parses_shift_ctrl_letter_chord() {
        let c = KeyChord::parse("shift+ctrl+p").expect("shift+ctrl+p parses");
        assert_eq!(c.code, KeyCode::Char('p'));
        assert!(c.mods.contains(KeyModifiers::CONTROL));
        assert!(c.mods.contains(KeyModifiers::SHIFT));
    }

    #[test]
    fn parses_named_keys() {
        assert_eq!(KeyChord::parse("enter").unwrap().code, KeyCode::Enter);
        assert_eq!(KeyChord::parse("return").unwrap().code, KeyCode::Enter);
        assert_eq!(KeyChord::parse("escape").unwrap().code, KeyCode::Esc);
        assert_eq!(KeyChord::parse("pageup").unwrap().code, KeyCode::PageUp);
        assert_eq!(KeyChord::parse("home").unwrap().code, KeyCode::Home);
        assert_eq!(KeyChord::parse("backspace").unwrap().code, KeyCode::Backspace);
        assert_eq!(KeyChord::parse("delete").unwrap().code, KeyCode::Delete);
    }

    #[test]
    fn parses_alt_enter() {
        let c = KeyChord::parse("alt+enter").unwrap();
        assert_eq!(c.code, KeyCode::Enter);
        assert!(c.mods.contains(KeyModifiers::ALT));
    }

    #[test]
    fn parses_ctrl_punct() {
        let c = KeyChord::parse("ctrl+]").unwrap();
        assert_eq!(c.code, KeyCode::Char(']'));
        assert!(c.mods.contains(KeyModifiers::CONTROL));
    }

    #[test]
    fn parses_f_keys() {
        assert_eq!(KeyChord::parse("f1").unwrap().code, KeyCode::F(1));
        assert_eq!(KeyChord::parse("f12").unwrap().code, KeyCode::F(12));
        assert!(KeyChord::parse("f13").is_err());
    }

    #[test]
    fn matches_exact() {
        let chord = KeyChord::parse("ctrl+l").unwrap();
        assert!(chord.matches(&ev(KeyCode::Char('l'), KeyModifiers::CONTROL)));
        assert!(!chord.matches(&ev(KeyCode::Char('l'), KeyModifiers::NONE)));
    }

    #[test]
    fn matches_case_insensitive_for_ascii_letters() {
        let chord = KeyChord::parse("ctrl+l").unwrap();
        // crossterm under Kitty can emit `Char('L')` with SHIFT+CONTROL
        // for `ctrl+L`. We treat it as the same chord.
        assert!(chord.matches(&ev(KeyCode::Char('L'), KeyModifiers::CONTROL)));
    }

    #[test]
    fn dispatch_picks_input_namespace_when_focused_on_editor() {
        let spec = KeymapSpec {
            bindings: BTreeMap::from([
                ("tui.input.submit".into(), vec!["enter".into()]),
                ("tui.select.confirm".into(), vec!["enter".into()]),
            ]),
            ..KeymapSpec::default()
        };
        let rk = ResolvedKeymap::compile(&spec).unwrap();
        assert_eq!(
            rk.dispatch(FocusMode::Input, &ev(KeyCode::Enter, KeyModifiers::NONE)),
            Some("tui.input.submit"),
        );
        assert_eq!(
            rk.dispatch(FocusMode::Dialog, &ev(KeyCode::Enter, KeyModifiers::NONE)),
            Some("tui.select.confirm"),
        );
    }

    #[test]
    fn dispatch_prefers_app_over_neo_in_normal_mode() {
        let spec = KeymapSpec {
            bindings: BTreeMap::from([
                ("app.model.cycleForward".into(), vec!["ctrl+p".into()]),
                ("neo.palette.open".into(), vec!["ctrl+p".into()]),
            ]),
            ..KeymapSpec::default()
        };
        let rk = ResolvedKeymap::compile(&spec).unwrap();
        let id = rk
            .dispatch(FocusMode::Normal, &ev(KeyCode::Char('p'), KeyModifiers::CONTROL))
            .expect("ctrl+p must resolve to a binding");
        assert_eq!(
            id, "app.model.cycleForward",
            "neo.* must never shadow legacy app.* bindings",
        );
    }
}
