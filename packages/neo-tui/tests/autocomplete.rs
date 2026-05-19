use std::fs;
use std::path::Path;

use senpi_neo_tui::components::autocomplete::{Autocomplete, AutocompleteResult};

fn crate_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

fn labels(result: AutocompleteResult) -> Vec<String> {
    match result {
        AutocompleteResult::Slash(items) | AutocompleteResult::Path(items) => {
            items.into_iter().map(|item| item.label).collect()
        }
        AutocompleteResult::None => Vec::new(),
    }
}

#[test]
fn autocomplete_slash_returns_commands_for_leading_slash() {
    let mut autocomplete = Autocomplete::new();

    let items = labels(autocomplete.trigger("/", crate_root()));

    assert!(items.iter().any(|item| item == "/help"));
    assert!(items.iter().any(|item| item == "/quit"));
    assert!(items.iter().any(|item| item == "/model"));
}

#[test]
fn autocomplete_slash_filters_by_prefix() {
    let mut autocomplete = Autocomplete::new();

    let items = labels(autocomplete.trigger("/he", crate_root()));

    assert!(!items.is_empty());
    assert!(items.iter().all(|item| item.starts_with("/he")));
}

#[test]
fn autocomplete_path_triggered_by_at() {
    let mut autocomplete = Autocomplete::new();

    let items = labels(autocomplete.trigger("@src/", crate_root()));

    assert!(!items.is_empty());
    assert!(items.iter().any(|item| item == "lib.rs"));
}

#[test]
fn autocomplete_path_relative() {
    let mut autocomplete = Autocomplete::new();

    let items = labels(autocomplete.trigger("@./Cargo.toml", crate_root()));

    assert!(
        items
            .iter()
            .any(|item| item == "Cargo.toml" || item == "./Cargo.toml")
    );
}

#[test]
fn autocomplete_no_trigger_returns_empty() {
    let mut autocomplete = Autocomplete::new();

    let result = autocomplete.trigger("hello", crate_root());

    assert!(matches!(result, AutocompleteResult::None));
}

#[test]
fn autocomplete_path_nonexistent_dir_empty() {
    let mut autocomplete = Autocomplete::new();

    let result = autocomplete.trigger("@/nonexistent_xyz_path/", crate_root());

    let AutocompleteResult::Path(items) = result else {
        panic!("expected path completion result");
    };
    assert!(items.is_empty());
}

#[test]
fn autocomplete_slash_fuzzy_ranks() {
    let mut autocomplete = Autocomplete::new();

    let items = labels(autocomplete.trigger("/hp", crate_root()));

    assert_eq!(items.first().map(String::as_str), Some("/help"));
}

#[test]
fn autocomplete_path_ignores_hidden_by_default() {
    let temp_dir = tempfile::tempdir().unwrap();
    fs::write(temp_dir.path().join(".hidden"), "secret").unwrap();
    fs::write(temp_dir.path().join("visible"), "shown").unwrap();
    let mut autocomplete = Autocomplete::new();

    let items = labels(autocomplete.trigger("@./", temp_dir.path()));

    assert!(items.iter().any(|item| item == "visible"));
    assert!(!items.iter().any(|item| item.starts_with('.')));
}
