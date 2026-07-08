package store

import (
	"os"
	"path/filepath"
	"strings"
)

// Config resolves the on-disk locations of the senpi agent directory and the
// files within it. It mirrors packages/coding-agent/src/config.ts:494-561: the
// env-var name is derived from the (upper-cased) app name, and the default
// agent dir is <home>/<configDirName>/agent.
type Config struct {
	// AppName is the piConfig.name (e.g. "senpi" or "pi"). It determines the
	// env override name via strings.ToUpper(AppName)+"_CODING_AGENT_DIR".
	AppName string
	// ConfigDirName is the piConfig.configDir (e.g. ".senpi" or ".pi").
	ConfigDirName string
}

// DefaultConfig returns the Config for this build (senpi / .senpi), mirroring
// the resolved APP_NAME and CONFIG_DIR_NAME in config.ts:489-491.
func DefaultConfig() Config {
	return Config{AppName: "senpi", ConfigDirName: ".senpi"}
}

// envAgentDirName mirrors config.ts:495 ENV_AGENT_DIR.
func (c Config) envAgentDirName() string {
	return strings.ToUpper(c.AppName) + "_CODING_AGENT_DIR"
}

// AgentDirEnvName exposes the agent-dir env var name (e.g. SENPI_CODING_AGENT_DIR)
// so callers spawning a subprocess can pin it explicitly rather than relying on
// ambient inheritance.
func (c Config) AgentDirEnvName() string { return c.envAgentDirName() }

// SessionDirEnvName exposes the session-dir env var name (e.g.
// SENPI_CODING_AGENT_SESSION_DIR), mirroring config.ts ENV_SESSION_DIR.
func (c Config) SessionDirEnvName() string {
	return strings.ToUpper(c.AppName) + "_CODING_AGENT_SESSION_DIR"
}

// AgentDir resolves the agent config directory, mirroring getAgentDir
// (config.ts:514-521): the env override wins (tilde/relative-expanded), else
// <home>/<configDirName>/agent.
func (c Config) AgentDir() string {
	if envDir := os.Getenv(c.envAgentDirName()); envDir != "" {
		return expandTildePath(envDir)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		// Mirror Node's homedir(): on the rare failure just use the config dir
		// relative to the (empty) home, keeping resolution total and crash-free.
		home = ""
	}
	return filepath.Join(home, c.ConfigDirName, "agent")
}

// SettingsPath mirrors getSettingsPath (config.ts:538-541).
func (c Config) SettingsPath() string { return filepath.Join(c.AgentDir(), "settings.json") }

// ModelsPath mirrors getModelsPath (config.ts:528-531).
func (c Config) ModelsPath() string { return filepath.Join(c.AgentDir(), "models.json") }

// AuthPath mirrors getAuthPath (config.ts:533-536).
func (c Config) AuthPath() string { return filepath.Join(c.AgentDir(), "auth.json") }

// KeybindingsPath mirrors KeybindingsManager.create (keybindings.ts:362-363).
func (c Config) KeybindingsPath() string { return filepath.Join(c.AgentDir(), "keybindings.json") }

// SessionsDir mirrors getSessionsDir (config.ts:559-561).
func (c Config) SessionsDir() string { return filepath.Join(c.AgentDir(), "sessions") }

// CustomThemesDir mirrors getCustomThemesDir (config.ts:524-526).
func (c Config) CustomThemesDir() string { return filepath.Join(c.AgentDir(), "themes") }

// ProjectSettingsPath returns <cwd>/<configDirName>/settings.json, mirroring
// FileSettingsStorage's projectSettingsPath (settings-manager.ts:210).
func (c Config) ProjectSettingsPath(cwd string) string {
	return filepath.Join(resolvePath(cwd), c.ConfigDirName, "settings.json")
}

// expandTildePath mirrors expandTildePath -> normalizePath (config.ts:498-500):
// a leading ~ is replaced with the user's home directory and the result is made
// absolute.
func expandTildePath(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, "~\\") {
		if home, err := os.UserHomeDir(); err == nil {
			rest := strings.TrimPrefix(p, "~")
			rest = strings.TrimLeft(rest, `/\`)
			p = filepath.Join(home, rest)
		}
	}
	return resolvePath(p)
}

// resolvePath makes a path absolute (mirrors resolvePath in the TS utils, which
// is path.resolve). Clean-only fallback keeps it total if abs resolution fails.
func resolvePath(p string) string {
	if abs, err := filepath.Abs(p); err == nil {
		return abs
	}
	return filepath.Clean(p)
}
