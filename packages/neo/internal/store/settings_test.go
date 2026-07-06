package store_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%s): %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%s): %v", path, err)
	}
}

// TestSettingsGlobalOnly loads global settings.json when no project file exists.
func TestSettingsGlobalOnly(t *testing.T) {
	agentDir := t.TempDir()
	cwd := t.TempDir()
	writeFile(t, filepath.Join(agentDir, "settings.json"), `{"theme":"grok-day","quietStartup":true}`)

	s, err := store.LoadSettings(cwd, agentDir)
	if err != nil {
		t.Fatalf("LoadSettings: %v", err)
	}
	if s.Theme != "grok-day" {
		t.Errorf("Theme = %q, want grok-day", s.Theme)
	}
}

// TestSettingsProjectWins mirrors settings-manager.ts deepMergeSettings: the
// project file at <cwd>/.senpi/settings.json overrides the global file.
func TestSettingsProjectWins(t *testing.T) {
	agentDir := t.TempDir()
	cwd := t.TempDir()
	writeFile(t, filepath.Join(agentDir, "settings.json"), `{"theme":"grok-day","defaultModel":"global-model"}`)
	writeFile(t, filepath.Join(cwd, ".senpi", "settings.json"), `{"theme":"grok-night"}`)

	s, err := store.LoadSettings(cwd, agentDir)
	if err != nil {
		t.Fatalf("LoadSettings: %v", err)
	}
	if s.Theme != "grok-night" {
		t.Errorf("Theme = %q, want grok-night (project wins)", s.Theme)
	}
	if s.DefaultModel != "global-model" {
		t.Errorf("DefaultModel = %q, want global-model (global preserved)", s.DefaultModel)
	}
}

// TestSettingsMissingFilesCleanDefaults mirrors config: absent files yield an
// empty settings object with no error (clean defaults, no crash).
func TestSettingsMissingFilesCleanDefaults(t *testing.T) {
	agentDir := t.TempDir()
	cwd := t.TempDir()

	s, err := store.LoadSettings(cwd, agentDir)
	if err != nil {
		t.Fatalf("LoadSettings on empty tree returned error: %v", err)
	}
	if s.Theme != "" || s.NeoTheme != "" {
		t.Errorf("expected empty theme fields, got theme=%q neo.theme=%q", s.Theme, s.NeoTheme)
	}
}

// TestSettingsCorruptGlobalIsNonFatal mirrors tryLoadFromStorage: a parse error
// in one scope is captured, not thrown; the other scope still loads.
func TestSettingsCorruptGlobalIsNonFatal(t *testing.T) {
	agentDir := t.TempDir()
	cwd := t.TempDir()
	writeFile(t, filepath.Join(agentDir, "settings.json"), `{not valid json`)
	writeFile(t, filepath.Join(cwd, ".senpi", "settings.json"), `{"theme":"grok-night"}`)

	s, err := store.LoadSettings(cwd, agentDir)
	if err != nil {
		t.Fatalf("LoadSettings should not fail on corrupt global: %v", err)
	}
	if s.Theme != "grok-night" {
		t.Errorf("Theme = %q, want grok-night from project despite corrupt global", s.Theme)
	}
	if len(s.LoadErrors) == 0 {
		t.Errorf("expected a captured load error for corrupt global scope")
	}
}

// TestNeoThemeReadPrefersNeoKey asserts the neo skin is read from the separate
// neo.theme key, with classic "theme" only as a fallback.
func TestNeoThemeReadPrefersNeoKey(t *testing.T) {
	agentDir := t.TempDir()
	cwd := t.TempDir()
	writeFile(t, filepath.Join(agentDir, "settings.json"), `{"theme":"grok-day","neo.theme":"grok-night"}`)

	s, err := store.LoadSettings(cwd, agentDir)
	if err != nil {
		t.Fatalf("LoadSettings: %v", err)
	}
	if got := s.EffectiveNeoTheme(); got != "grok-night" {
		t.Errorf("EffectiveNeoTheme() = %q, want grok-night (neo.theme key)", got)
	}
}

// TestNeoThemeFallsBackToClassic asserts classic "theme" is used only when
// neo.theme is absent.
func TestNeoThemeFallsBackToClassic(t *testing.T) {
	agentDir := t.TempDir()
	cwd := t.TempDir()
	writeFile(t, filepath.Join(agentDir, "settings.json"), `{"theme":"grok-day"}`)

	s, err := store.LoadSettings(cwd, agentDir)
	if err != nil {
		t.Fatalf("LoadSettings: %v", err)
	}
	if got := s.EffectiveNeoTheme(); got != "grok-day" {
		t.Errorf("EffectiveNeoTheme() = %q, want grok-day (classic fallback)", got)
	}
}

// TestPiConfigResolvesConfigDirBothEntryPoints is the parameterization guardrail
// (audit-fix finding 2): LoadSettings and WriteNeoTheme must resolve the project
// scope through the Config's ConfigDirName, NOT a hardcoded ".senpi". A "pi"
// build (ConfigDirName ".pi") must read AND write <cwd>/.pi/settings.json. The
// assertion runs through BOTH entry points so neither can silently revert to the
// hardcoded ".senpi".
func TestPiConfigResolvesConfigDirBothEntryPoints(t *testing.T) {
	agentDir := t.TempDir()
	cwd := t.TempDir()
	piCfg := store.Config{AppName: "pi", ConfigDirName: ".pi"}

	// A senpi-shaped project file must be IGNORED by a pi build: only <cwd>/.pi
	// counts. This proves resolution is not hardcoded to ".senpi".
	writeFile(t, filepath.Join(cwd, ".senpi", "settings.json"), `{"neo.theme":"senpi-project-should-be-ignored"}`)

	// WRITE entry point: WriteNeoTheme must land in <cwd>/.pi/settings.json.
	if err := piCfg.WriteNeoTheme(cwd, agentDir, store.ScopeProject, "grok-night"); err != nil {
		t.Fatalf("Config.WriteNeoTheme(pi): %v", err)
	}
	piPath := filepath.Join(cwd, ".pi", "settings.json")
	if _, err := os.Stat(piPath); err != nil {
		t.Fatalf("pi build wrote to the wrong dir; expected %s: %v", piPath, err)
	}
	// The .senpi project file must NOT have been touched by a pi write.
	senpiPath := filepath.Join(cwd, ".senpi", "settings.json")
	senpiRaw := rawJSON(t, senpiPath)
	if senpiRaw["neo.theme"] != "senpi-project-should-be-ignored" {
		t.Errorf("pi write mutated .senpi project file: %v", senpiRaw)
	}
	piRaw := rawJSON(t, piPath)
	if piRaw["neo.theme"] != "grok-night" {
		t.Errorf("pi write .pi neo.theme = %v, want grok-night", piRaw["neo.theme"])
	}

	// READ entry point: LoadSettings for a pi build must read <cwd>/.pi (the value
	// just written), NOT the .senpi file.
	s, err := piCfg.LoadSettings(cwd, agentDir)
	if err != nil {
		t.Fatalf("Config.LoadSettings(pi): %v", err)
	}
	if got := s.EffectiveNeoTheme(); got != "grok-night" {
		t.Errorf("pi LoadSettings EffectiveNeoTheme() = %q, want grok-night (from <cwd>/.pi)", got)
	}
}

// rawJSON reads a settings file as an ordered/loose map to assert exact keys.
func rawJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", path, err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("Unmarshal(%s): %v", path, err)
	}
	return m
}
