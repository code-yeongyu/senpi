package theme

import (
	"os"
	"path/filepath"
	"testing"
)

// Loader goldens: neo resolves its theme from settings.json + custom themes in
// ~/.senpi/agent/themes, defaulting to grok-night. Agent-dir resolution honors
// the ${APP_NAME}_CODING_AGENT_DIR env override (config.ts getAgentDir).

func TestLoadDefaultsToGrokNight(t *testing.T) {
	th, err := Load(Options{})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if th.Name() != "grok-night" {
		t.Fatalf("default: want grok-night, got %q", th.Name())
	}
}

func TestLoadBuiltinGrokDay(t *testing.T) {
	th, err := Load(Options{Name: "grok-day"})
	if err != nil {
		t.Fatalf("Load grok-day: %v", err)
	}
	if th.Name() != "grok-day" {
		t.Fatalf("want grok-day, got %q", th.Name())
	}
	// The day theme's blue accent is the exact day-table hex.
	if got := th.AccentBlueHex(); got != goldDayBlue.hex {
		t.Fatalf("grok-day accent blue: want %s, got %s", goldDayBlue.hex, got)
	}
}

// TestLoadFromSettingsThemeKey: the loader reads the settings `theme` value from
// the agent dir's settings.json when Options.Name is empty.
func TestLoadFromSettingsThemeKey(t *testing.T) {
	agentDir := t.TempDir()
	writeJSON(t, filepath.Join(agentDir, "settings.json"), map[string]any{"theme": "grok-day"})

	th, err := Load(Options{AgentDir: agentDir})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if th.Name() != "grok-day" {
		t.Fatalf("settings theme=grok-day: got %q", th.Name())
	}
}

// TestExplicitNameBeatsSettings: Options.Name overrides settings.json theme.
func TestExplicitNameBeatsSettings(t *testing.T) {
	agentDir := t.TempDir()
	writeJSON(t, filepath.Join(agentDir, "settings.json"), map[string]any{"theme": "grok-day"})

	th, err := Load(Options{AgentDir: agentDir, Name: "grok-night"})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if th.Name() != "grok-night" {
		t.Fatalf("explicit name should win: got %q", th.Name())
	}
}

// TestLoadCustomThemeFromThemesDir: a custom theme JSON in
// <agentDir>/themes/<name>.json is resolvable by name and its colors win.
func TestLoadCustomThemeFromThemesDir(t *testing.T) {
	agentDir := t.TempDir()
	themesDir := filepath.Join(agentDir, "themes")
	if err := os.MkdirAll(themesDir, 0o755); err != nil {
		t.Fatalf("mkdir themes: %v", err)
	}
	custom := map[string]any{
		"name": "my-neon",
		"colors": map[string]any{
			"surfaceBase": "#010203",
			"textPrimary": "#0a0b0c",
			"accentGreen": "#04ff00",
		},
	}
	writeJSON(t, filepath.Join(themesDir, "my-neon.json"), custom)

	th, err := Load(Options{AgentDir: agentDir, Name: "my-neon"})
	if err != nil {
		t.Fatalf("Load custom: %v", err)
	}
	if th.Name() != "my-neon" {
		t.Fatalf("custom theme name: got %q", th.Name())
	}
	if got := th.SurfaceBaseHex(); got != "#010203" {
		t.Fatalf("custom surfaceBase: want #010203, got %s", got)
	}
	if got := th.AccentGreenHex(); got != "#04ff00" {
		t.Fatalf("custom accentGreen: want #04ff00, got %s", got)
	}
	// Unspecified keys fall back to the grok-night base palette.
	if got := th.TextMutedHex(); got != goldTextMuted.hex {
		t.Fatalf("custom theme unspecified textMuted should inherit night default %s, got %s", goldTextMuted.hex, got)
	}
}

// TestCustomThemeOverridesBuiltinName: a custom theme file named grok-night is
// allowed to override the builtin (classic parity: custom themes shadow builtins).
func TestCustomThemeOverridesBuiltinName(t *testing.T) {
	agentDir := t.TempDir()
	themesDir := filepath.Join(agentDir, "themes")
	if err := os.MkdirAll(themesDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	writeJSON(t, filepath.Join(themesDir, "grok-night.json"), map[string]any{
		"name":   "grok-night",
		"colors": map[string]any{"surfaceBase": "#123456"},
	})
	th, err := Load(Options{AgentDir: agentDir, Name: "grok-night"})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := th.SurfaceBaseHex(); got != "#123456" {
		t.Fatalf("custom grok-night override: want #123456, got %s", got)
	}
}

// TestUnknownThemeNameFallsBackToDefault: an unknown theme name yields the
// grok-night default rather than an error (classic parity: invalid theme → default).
func TestUnknownThemeNameFallsBackToDefault(t *testing.T) {
	agentDir := t.TempDir()
	th, err := Load(Options{AgentDir: agentDir, Name: "does-not-exist"})
	if err != nil {
		t.Fatalf("Load unknown: %v", err)
	}
	if th.Name() != "grok-night" {
		t.Fatalf("unknown theme should fall back to grok-night, got %q", th.Name())
	}
}

// TestAgentDirEnvOverride: when Options.AgentDir is empty, the loader honors the
// ${APP_NAME}_CODING_AGENT_DIR env var (config.ts getAgentDir semantics).
func TestAgentDirEnvOverride(t *testing.T) {
	agentDir := t.TempDir()
	writeJSON(t, filepath.Join(agentDir, "settings.json"), map[string]any{"theme": "grok-day"})
	// APP_NAME for senpi is "pi" per config.ts APP_NAME default; the neo store
	// reader honors PI_CODING_AGENT_DIR. Set both spellings the loader checks.
	t.Setenv("PI_CODING_AGENT_DIR", agentDir)
	t.Setenv("SENPI_CODING_AGENT_DIR", agentDir)

	th, err := Load(Options{})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if th.Name() != "grok-day" {
		t.Fatalf("env agent dir settings theme: want grok-day, got %q", th.Name())
	}
}

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	b := mustMarshal(t, v)
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
