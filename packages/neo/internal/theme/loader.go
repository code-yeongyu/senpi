package theme

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Options controls theme resolution.
type Options struct {
	// Name selects an explicit theme (builtin or custom). Empty → read from
	// settings.json, else fall back to the neo default (grok-night).
	Name string
	// AgentDir overrides the agent config directory (…/.senpi/agent). Empty →
	// resolved from the ${APP}_CODING_AGENT_DIR env vars, then ~/.senpi/agent.
	AgentDir string
}

// customThemeFile mirrors the classic custom-theme JSON shape
// ({name, colors:{...}}), so neo custom themes drop into the SAME
// ~/.senpi/agent/themes directory the classic TUI reads.
type customThemeFile struct {
	Name   string            `json:"name"`
	Colors map[string]string `json:"colors"`
}

// settingsFile is the minimal read view of settings.json for theme resolution.
// neo reads the classic `theme` key here (read-only); it never writes it (the
// store package owns the neo.theme write path, guardrail-per plan task 4).
type settingsFile struct {
	Theme string `json:"theme"`
}

// Load resolves and builds a Theme.
//
// Resolution order for the name:
//  1. Options.Name when non-empty.
//  2. settings.json `theme` in the agent dir.
//  3. The neo default, grok-night.
//
// A name resolves to a custom theme (…/themes/<name>.json) first — custom themes
// shadow builtins, matching classic parity — then a builtin, then (if unknown)
// falls back to grok-night. Load never returns an error for an unknown name;
// it degrades to the default, mirroring the classic loader.
func Load(opts Options) (*Theme, error) {
	agentDir := opts.AgentDir
	if agentDir == "" {
		agentDir = resolveAgentDir()
	}

	name := opts.Name
	if name == "" {
		name = readSettingsTheme(agentDir)
	}
	if name == "" {
		name = DefaultThemeName
	}

	// Custom theme file wins over a builtin of the same name.
	if agentDir != "" {
		if p, ok := loadCustomPalette(agentDir, name); ok {
			return newTheme(name, p), nil
		}
	}

	if p, ok := builtinPalettes[name]; ok {
		return newTheme(name, p), nil
	}

	// Unknown name → neo default.
	return newTheme(DefaultThemeName, grokNight), nil
}

// resolveAgentDir mirrors config.ts getAgentDir: honor the coding-agent dir env
// override (PI_/SENPI_ spellings), else ~/.senpi/agent.
func resolveAgentDir() string {
	for _, key := range []string{"PI_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR"} {
		if v := os.Getenv(key); v != "" {
			return v
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".senpi", "agent")
}

// readSettingsTheme reads the `theme` value from <agentDir>/settings.json.
// Missing file / parse errors yield "" (caller falls back to the default).
func readSettingsTheme(agentDir string) string {
	if agentDir == "" {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(agentDir, "settings.json"))
	if err != nil {
		return ""
	}
	var s settingsFile
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return s.Theme
}

// loadCustomPalette reads <agentDir>/themes/<name>.json and merges its colors
// over the grok-night base, so unspecified keys inherit the default skin. It
// returns ok=false when the file is absent or unparseable.
func loadCustomPalette(agentDir, name string) (Palette, bool) {
	path := filepath.Join(agentDir, "themes", name+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return Palette{}, false
	}
	var f customThemeFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return Palette{}, false
	}
	// Base on the light day skin when the file name implies a light theme; else
	// the night default. Custom colors then override per key.
	base := grokNight
	if b, ok := builtinPalettes[name]; ok {
		base = b
	}
	return mergePalette(base, f.Colors), true
}

// mergePalette overlays a colors map (custom-theme JSON keys) onto a base
// palette. Keys are the JSON field names of Palette; unknown keys are ignored.
func mergePalette(base Palette, colors map[string]string) Palette {
	set := func(dst *string, key string) {
		if v, ok := colors[key]; ok && v != "" {
			*dst = v
		}
	}
	set(&base.SurfaceBase, "surfaceBase")
	set(&base.SurfacePanel, "surfacePanel")
	set(&base.SurfaceHighlight, "surfaceHighlight")
	set(&base.SurfaceAltRow, "surfaceAltRow")
	set(&base.SurfaceSelected, "surfaceSelected")
	set(&base.TextPrimary, "textPrimary")
	set(&base.TextSecondary, "textSecondary")
	set(&base.TextMuted, "textMuted")
	set(&base.TextDim, "textDim")
	set(&base.TextFaint, "textFaint")
	set(&base.TextLabel, "textLabel")
	set(&base.AccentGreen, "accentGreen")
	set(&base.AccentRed, "accentRed")
	set(&base.AccentBlue, "accentBlue")
	set(&base.AccentYellow, "accentYellow")
	set(&base.AccentCyan, "accentCyan")
	set(&base.BorderInput, "borderInput")
	set(&base.BorderCard, "borderCard")
	set(&base.BorderModal, "borderModal")
	return base
}
