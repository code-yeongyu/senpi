package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// SettingsScope selects the global (agent-dir) or project (<cwd>/.senpi) file,
// mirroring SettingsScope in settings-manager.ts:187.
type SettingsScope string

const (
	// ScopeGlobal targets <agentDir>/settings.json.
	ScopeGlobal SettingsScope = "global"
	// ScopeProject targets <cwd>/<configDir>/settings.json.
	ScopeProject SettingsScope = "project"
)

// neoThemeKey is the SEPARATE settings key neo persists its skin under. It is
// intentionally distinct from the classic "theme" key: writing "theme" would
// change classic-TUI behavior, violating the additive-only guardrail.
const neoThemeKey = "neo.theme"

// classicThemeKey is the classic TUI skin key, read only as a fallback.
const classicThemeKey = "theme"

// ScopeLoadError records a per-scope parse failure without aborting the load,
// mirroring tryLoadFromStorage (settings-manager.ts:382-392).
type ScopeLoadError struct {
	Scope SettingsScope
	Err   error
}

func (e ScopeLoadError) Error() string {
	return fmt.Sprintf("settings %s scope: %v", e.Scope, e.Err)
}

// Settings is the merged (global <- project) settings view neo needs. It
// exposes the typed fields the TUI consumes plus the raw merged map so future
// fields do not require a schema change here.
type Settings struct {
	// Theme is the classic "theme" key. Neo reads it ONLY as a fallback and
	// never writes it.
	Theme string
	// NeoTheme is the neo-specific "neo.theme" key.
	NeoTheme string
	// DefaultModel mirrors settings.defaultModel (settings-manager.ts:96).
	DefaultModel string
	// Raw is the fully merged settings object (global overlaid by project).
	Raw map[string]any
	// LoadErrors holds any per-scope parse failures encountered while loading.
	LoadErrors []ScopeLoadError
}

// EffectiveNeoTheme returns the neo skin: the neo.theme key if present, else the
// classic theme key as a fallback, mirroring the task's read protocol.
func (s Settings) EffectiveNeoTheme() string {
	if s.NeoTheme != "" {
		return s.NeoTheme
	}
	return s.Theme
}

// LoadSettings loads and merges global then project settings for the default
// (senpi / .senpi) build. It delegates to Config.LoadSettings so both entry
// points resolve the project scope through the same ConfigDirName rather than a
// hardcoded ".senpi".
func LoadSettings(cwd, agentDir string) (Settings, error) {
	return DefaultConfig().LoadSettings(cwd, agentDir)
}

// LoadSettings loads and merges global then project settings, mirroring
// SettingsManager.fromStorage + deepMergeSettings (settings-manager.ts:319,
// 145-174). The project scope is resolved via THIS Config's ConfigDirName
// (e.g. ".pi" for a pi build), so a non-senpi build correctly reads
// <cwd>/<configDir>/settings.json. A parse error in one scope is captured in
// LoadErrors, not returned as a fatal error; the other scope still contributes.
func (c Config) LoadSettings(cwd, agentDir string) (Settings, error) {
	globalPath := filepath.Join(agentDir, "settings.json")
	projectPath := c.ProjectSettingsPath(cwd)

	var loadErrors []ScopeLoadError

	globalRaw, gErr := readSettingsMap(globalPath)
	if gErr != nil {
		loadErrors = append(loadErrors, ScopeLoadError{Scope: ScopeGlobal, Err: gErr})
		globalRaw = map[string]any{}
	}
	projectRaw, pErr := readSettingsMap(projectPath)
	if pErr != nil {
		loadErrors = append(loadErrors, ScopeLoadError{Scope: ScopeProject, Err: pErr})
		projectRaw = map[string]any{}
	}

	merged := deepMergeSettings(globalRaw, projectRaw)

	return Settings{
		Theme:        stringField(merged, classicThemeKey),
		NeoTheme:     stringField(merged, neoThemeKey),
		DefaultModel: stringField(merged, "defaultModel"),
		Raw:          merged,
		LoadErrors:   loadErrors,
	}, nil
}

// readSettingsMap reads and JSON-parses a settings file. A missing file yields
// an empty map with no error (mirrors loadFromStorage's !content -> {} branch,
// settings-manager.ts:375-377). A present-but-corrupt file returns an error.
func readSettingsMap(path string) (map[string]any, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return map[string]any{}, nil
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	if m == nil {
		m = map[string]any{}
	}
	return m, nil
}

// deepMergeSettings mirrors deepMergeSettings (settings-manager.ts:145-174):
// project (overrides) wins; nested plain objects merge one level; arrays and
// primitives are replaced wholesale. undefined (absent) override values are
// skipped.
func deepMergeSettings(base, overrides map[string]any) map[string]any {
	result := make(map[string]any, len(base)+len(overrides))
	for k, v := range base {
		result[k] = v
	}
	for k, overrideValue := range overrides {
		if overrideValue == nil {
			continue
		}
		baseValue, ok := result[k]
		overrideObj, overrideIsObj := asPlainObject(overrideValue)
		baseObj, baseIsObj := asPlainObject(baseValue)
		if ok && overrideIsObj && baseIsObj {
			merged := make(map[string]any, len(baseObj)+len(overrideObj))
			for bk, bv := range baseObj {
				merged[bk] = bv
			}
			for ok2, ov := range overrideObj {
				merged[ok2] = ov
			}
			result[k] = merged
			continue
		}
		result[k] = overrideValue
	}
	return result
}

// asPlainObject reports whether v is a non-array JSON object (map), mirroring
// the typeof === "object" && !Array.isArray guard in deepMergeSettings.
func asPlainObject(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

func stringField(m map[string]any, key string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}
