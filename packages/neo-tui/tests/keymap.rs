//! Contract tests for the keymap system.
//!
//! `parse` must round-trip the bundled keymap and preserve every binding
//! verbatim. Beyond that, this file enforces the strongest contract
//! the neo-tui has: 100% keybinding parity with the legacy
//! `@earendil-works/pi-tui` + `@code-yeongyu/senpi` interactive TUI.
//!
//! TDD discipline: every binding from the legacy registries is encoded
//! here as a hard-coded expectation. If anyone bumps a default key (in
//! either neo-tui's JSON or the upstream TS registries) this test fails
//! with a clear message pointing at the drift. A complementary TypeScript
//! regression test (`packages/coding-agent/test/suite/regressions/
//! neo-tui-keymap-parity.test.ts`) re-validates the same table against
//! the actual `KEYBINDINGS` constant so we catch drift on both sides.
//!
//! The Rust parser intentionally accepts arbitrary action ids; runtime
//! dispatch owns the distinction between implemented, context-scoped, and
//! visibly unimplemented actions.

use senpi_neo_tui::keymap;

const DEFAULT_JSON: &str = senpi_neo_tui::DEFAULT_KEYMAP_JSON;

/// Source of truth for the test: every binding from
/// `packages/tui/src/keybindings.ts::TUI_KEYBINDINGS` and
/// `packages/coding-agent/src/core/keybindings.ts::KEYBINDINGS`,
/// using the **non-Windows** branch where the legacy registry
/// platform-forks (`app.suspend`, `app.clipboard.pasteImage`).
const LEGACY_REGISTRY: &[(&str, &[&str])] = &[
    // === packages/tui::TUI_KEYBINDINGS ===
    ("tui.editor.cursorUp", &["up"]),
    ("tui.editor.cursorDown", &["down"]),
    ("tui.editor.cursorLeft", &["left", "ctrl+b"]),
    ("tui.editor.cursorRight", &["right", "ctrl+f"]),
    ("tui.editor.cursorWordLeft", &["alt+left", "ctrl+left", "alt+b"]),
    (
        "tui.editor.cursorWordRight",
        &["alt+right", "ctrl+right", "alt+f"],
    ),
    ("tui.editor.cursorLineStart", &["home", "ctrl+a"]),
    ("tui.editor.cursorLineEnd", &["end", "ctrl+e"]),
    ("tui.editor.jumpForward", &["ctrl+]"]),
    ("tui.editor.jumpBackward", &["ctrl+alt+]"]),
    ("tui.editor.pageUp", &["pageUp"]),
    ("tui.editor.pageDown", &["pageDown"]),
    ("tui.editor.deleteCharBackward", &["backspace"]),
    ("tui.editor.deleteCharForward", &["delete", "ctrl+d"]),
    ("tui.editor.deleteWordBackward", &["ctrl+w", "alt+backspace"]),
    ("tui.editor.deleteWordForward", &["alt+d", "alt+delete"]),
    ("tui.editor.deleteToLineStart", &["ctrl+u"]),
    ("tui.editor.deleteToLineEnd", &["ctrl+k"]),
    ("tui.editor.yank", &["ctrl+y"]),
    ("tui.editor.yankPop", &["alt+y"]),
    ("tui.editor.undo", &["ctrl+-"]),
    ("tui.input.newLine", &["shift+enter"]),
    ("tui.input.submit", &["enter"]),
    ("tui.input.tab", &["tab"]),
    ("tui.input.copy", &["ctrl+c"]),
    ("tui.select.up", &["up"]),
    ("tui.select.down", &["down"]),
    ("tui.select.pageUp", &["pageUp"]),
    ("tui.select.pageDown", &["pageDown"]),
    ("tui.select.confirm", &["enter"]),
    ("tui.select.cancel", &["escape", "ctrl+c"]),
    // === packages/coding-agent::KEYBINDINGS (app.*) ===
    ("app.interrupt", &["escape"]),
    ("app.clear", &["ctrl+c"]),
    ("app.exit", &["ctrl+d"]),
    ("app.suspend", &["ctrl+z"]),
    ("app.thinking.cycle", &["shift+tab"]),
    ("app.model.cycleForward", &["ctrl+p"]),
    ("app.model.cycleBackward", &["shift+ctrl+p"]),
    ("app.model.select", &["ctrl+l"]),
    ("app.history.search", &["ctrl+r"]),
    ("app.sessions.observe", &["ctrl+s"]),
    ("app.tools.expand", &["ctrl+o"]),
    ("app.thinking.toggle", &["ctrl+t"]),
    ("app.session.toggleNamedFilter", &["ctrl+n"]),
    ("app.editor.external", &["ctrl+g"]),
    ("app.message.followUp", &["alt+enter"]),
    ("app.message.dequeue", &["alt+up"]),
    ("app.clipboard.pasteImage", &["ctrl+v"]),
    ("app.session.new", &[]),
    ("app.session.tree", &[]),
    ("app.session.fork", &[]),
    ("app.session.resume", &[]),
    ("app.tree.foldOrUp", &["ctrl+left", "alt+left"]),
    ("app.tree.unfoldOrDown", &["ctrl+right", "alt+right"]),
    ("app.tree.editLabel", &["shift+l"]),
    ("app.tree.toggleLabelTimestamp", &["shift+t"]),
    ("app.tree.filter.default", &["ctrl+d"]),
    ("app.tree.filter.noTools", &["ctrl+t"]),
    ("app.tree.filter.userOnly", &["ctrl+u"]),
    ("app.tree.filter.labeledOnly", &["ctrl+l"]),
    ("app.tree.filter.all", &["ctrl+a"]),
    ("app.tree.filter.cycleForward", &["ctrl+o"]),
    ("app.tree.filter.cycleBackward", &["shift+ctrl+o"]),
    ("app.session.togglePath", &["ctrl+p"]),
    ("app.session.toggleSort", &["ctrl+s"]),
    ("app.session.rename", &["ctrl+r"]),
    ("app.session.delete", &["ctrl+d"]),
    ("app.session.deleteNoninvasive", &["ctrl+backspace"]),
    ("app.models.save", &["ctrl+s"]),
    ("app.models.toggleFavorite", &["ctrl+f"]),
    ("app.models.enableAll", &["ctrl+a"]),
    ("app.models.clearAll", &["ctrl+x"]),
    ("app.models.toggleProvider", &["ctrl+p"]),
    ("app.models.reorderUp", &["alt+up"]),
    ("app.models.reorderDown", &["alt+down"]),
];

#[test]
fn parses_default_keymap() {
    let spec = keymap::parse(DEFAULT_JSON).expect("default keymap must parse");
    assert!(
        spec.bindings.len() >= LEGACY_REGISTRY.len(),
        "default keymap should carry at least every legacy binding (got {} expected >= {})",
        spec.bindings.len(),
        LEGACY_REGISTRY.len(),
    );
}

/// Exhaustive parity test: EVERY binding from the legacy senpi
/// (pi-tui + coding-agent) registry must be present in the bundled
/// default keymap with the EXACT same default keys in the EXACT same
/// order. Any drift fails this test with a clear pointer at the
/// offending binding.
#[test]
fn bundled_default_keymap_matches_legacy_senpi_registry_one_to_one() {
    let spec = keymap::parse(DEFAULT_JSON).expect("default keymap must parse");
    let mut missing: Vec<&str> = Vec::new();
    let mut drift: Vec<String> = Vec::new();

    for (id, expected_keys) in LEGACY_REGISTRY {
        match spec.bindings.get(*id) {
            None => missing.push(*id),
            Some(actual_keys) => {
                let actual: Vec<&str> = actual_keys.iter().map(String::as_str).collect();
                if actual.as_slice() != *expected_keys {
                    drift.push(format!("  - `{id}` legacy={expected_keys:?} neo={actual:?}"));
                }
            }
        }
    }

    assert!(
        missing.is_empty() && drift.is_empty(),
        "neo-tui default keymap drifted from the legacy senpi registry.\n\
         missing bindings: {missing:?}\n\
         drifted bindings:\n{}",
        drift.join("\n"),
    );
}

/// The neo-tui keymap may add bindings that the legacy registry does
/// not have, but they MUST live under the `neo.*` namespace so they
/// cannot collide with future legacy additions.
#[test]
fn extra_bindings_are_neo_namespaced() {
    let spec = keymap::parse(DEFAULT_JSON).expect("default keymap must parse");
    let legacy_ids: std::collections::HashSet<&str> = LEGACY_REGISTRY.iter().map(|(id, _)| *id).collect();
    let mut offenders: Vec<String> = Vec::new();
    for id in spec.bindings.keys() {
        if legacy_ids.contains(id.as_str()) {
            continue;
        }
        if !id.starts_with("neo.") {
            offenders.push(id.clone());
        }
    }
    assert!(
        offenders.is_empty(),
        "non-legacy bindings must live under `neo.*` to avoid future\n\
         conflicts with the upstream registry, but found: {offenders:?}",
    );
}

#[test]
fn default_keymap_binds_input_history_navigation() {
    let spec = keymap::parse(DEFAULT_JSON).expect("default keymap must parse");
    let prev = spec
        .bindings
        .get("neo.input.historyPrev")
        .expect("history previous binding must exist");
    let next = spec
        .bindings
        .get("neo.input.historyNext")
        .expect("history next binding must exist");
    let prev_keys: Vec<&str> = prev.iter().map(String::as_str).collect();
    let next_keys: Vec<&str> = next.iter().map(String::as_str).collect();

    assert_eq!(prev_keys.as_slice(), ["up"]);
    assert_eq!(next_keys.as_slice(), ["down"]);
}

#[test]
fn default_keymap_binds_shift_enter_to_legacy_input_newline() {
    // Bug 1 regression: tmux + xterm modifyOtherKeys mode 2 lets the
    // composer receive `shift+enter` as a distinct key (vs upstream's
    // legacy `Enter` collision). The dispatch path uses the LEGACY
    // `tui.input.newLine` binding from `TUI_KEYBINDINGS` (`pi-tui`), so
    // we don't add a redundant `neo.editor.newLine`. Lock the legacy
    // mapping here so a future drift in the bundled JSON fails the
    // parity test on this side too.
    let spec = keymap::parse(DEFAULT_JSON).expect("default keymap must parse");
    let keys = spec
        .bindings
        .get("tui.input.newLine")
        .expect("shift+enter newline must stay on the legacy tui.input.newLine binding");
    let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
    assert_eq!(keys.as_slice(), ["shift+enter"]);
}

#[test]
fn accepts_arbitrary_action_ids() {
    // The parser round-trips arbitrary string keys so the JSON can mirror
    // legacy senpi ids plus neo-only ids without a generated action enum.
    let bad = r#"{ "bindings": { "nonsense.action": ["alt+x"] } }"#;
    let spec = keymap::parse(bad).expect("parser accepts unknown action names today");
    assert!(spec.bindings.contains_key("nonsense.action"));
}
