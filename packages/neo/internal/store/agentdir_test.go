package store_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
)

// TestAgentDirFromEnv mirrors config.ts:515-521: the env override
// ${APP_NAME}_CODING_AGENT_DIR wins and its tilde/relative path is expanded to
// an absolute path.
func TestAgentDirFromEnv(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("SENPI_CODING_AGENT_DIR", tmp)

	cfg := store.DefaultConfig()
	got := cfg.AgentDir()
	if got != tmp {
		t.Fatalf("AgentDir() = %q, want %q", got, tmp)
	}
}

// TestAgentDirEnvExpandsTilde asserts a leading ~ in the env override is
// expanded to the user's home directory (expandTildePath -> normalizePath).
func TestAgentDirEnvExpandsTilde(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	t.Setenv("SENPI_CODING_AGENT_DIR", "~/custom-agent")

	cfg := store.DefaultConfig()
	want := filepath.Join(home, "custom-agent")
	if got := cfg.AgentDir(); got != want {
		t.Fatalf("AgentDir() = %q, want %q", got, want)
	}
}

// TestAgentDirDefault mirrors config.ts:520: with no env override, the agent
// dir is <home>/<configDir>/agent, i.e. ~/.senpi/agent for this build.
func TestAgentDirDefault(t *testing.T) {
	// Ensure no env override leaks in from the outer environment.
	t.Setenv("SENPI_CODING_AGENT_DIR", "")
	os.Unsetenv("SENPI_CODING_AGENT_DIR")

	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}

	cfg := store.DefaultConfig()
	want := filepath.Join(home, ".senpi", "agent")
	if got := cfg.AgentDir(); got != want {
		t.Fatalf("AgentDir() = %q, want %q", got, want)
	}
}

// TestAppNameDerivesEnvVar mirrors config.ts:495: the env var name is derived
// from the (upper-cased) app name, so a "pi" build reads PI_CODING_AGENT_DIR.
func TestAppNameDerivesEnvVar(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("PI_CODING_AGENT_DIR", tmp)

	cfg := store.Config{AppName: "pi", ConfigDirName: ".pi"}
	if got := cfg.AgentDir(); got != tmp {
		t.Fatalf("AgentDir() = %q, want %q", got, tmp)
	}
}

// TestConfigPathHelpers mirrors config.ts path getters (models.json, auth.json,
// settings.json, sessions/, themes/).
func TestConfigPathHelpers(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("SENPI_CODING_AGENT_DIR", tmp)
	cfg := store.DefaultConfig()

	cases := []struct {
		name string
		got  string
		want string
	}{
		{"settings", cfg.SettingsPath(), filepath.Join(tmp, "settings.json")},
		{"models", cfg.ModelsPath(), filepath.Join(tmp, "models.json")},
		{"auth", cfg.AuthPath(), filepath.Join(tmp, "auth.json")},
		{"keybindings", cfg.KeybindingsPath(), filepath.Join(tmp, "keybindings.json")},
		{"sessions", cfg.SessionsDir(), filepath.Join(tmp, "sessions")},
		{"themes", cfg.CustomThemesDir(), filepath.Join(tmp, "themes")},
	}
	for _, tc := range cases {
		if tc.got != tc.want {
			t.Errorf("%s path = %q, want %q", tc.name, tc.got, tc.want)
		}
	}
}
