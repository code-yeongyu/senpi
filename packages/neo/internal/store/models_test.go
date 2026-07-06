package store_test

import (
	"path/filepath"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
)

// TestLoadModelsConfig mirrors ModelsConfigSchema (model-registry.ts:256-263):
// providers is a record of providerId -> config, disabledProviders is optional.
func TestLoadModelsConfig(t *testing.T) {
	agentDir := t.TempDir()
	writeFile(t, filepath.Join(agentDir, "models.json"), `{
		"disabledProviders": ["legacy"],
		"providers": {
			"openai": {"baseUrl": "https://api.openai.com/v1", "models": [{"id": "gpt-x"}]},
			"anthropic": {"baseUrl": "https://api.anthropic.com"}
		}
	}`)

	cfg, err := store.LoadModelsConfig(agentDir)
	if err != nil {
		t.Fatalf("LoadModelsConfig: %v", err)
	}
	if len(cfg.Providers) != 2 {
		t.Fatalf("Providers len = %d, want 2", len(cfg.Providers))
	}
	if _, ok := cfg.Providers["openai"]; !ok {
		t.Errorf("missing openai provider")
	}
	if len(cfg.DisabledProviders) != 1 || cfg.DisabledProviders[0] != "legacy" {
		t.Errorf("DisabledProviders = %v, want [legacy]", cfg.DisabledProviders)
	}
}

// TestLoadModelsConfigMissing yields empty config, no error (clean defaults).
func TestLoadModelsConfigMissing(t *testing.T) {
	agentDir := t.TempDir()
	cfg, err := store.LoadModelsConfig(agentDir)
	if err != nil {
		t.Fatalf("LoadModelsConfig on missing file: %v", err)
	}
	if len(cfg.Providers) != 0 {
		t.Errorf("expected empty providers, got %v", cfg.Providers)
	}
}

// TestLoadModelsConfigCorrupt returns an error so callers can warn (unlike the
// tolerant session scan, models.json is validated up-front by the classic CLI).
func TestLoadModelsConfigCorrupt(t *testing.T) {
	agentDir := t.TempDir()
	writeFile(t, filepath.Join(agentDir, "models.json"), `{ bad`)
	_, err := store.LoadModelsConfig(agentDir)
	if err == nil {
		t.Errorf("expected error for corrupt models.json")
	}
}
