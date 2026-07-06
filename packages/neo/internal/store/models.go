package store

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// ModelsConfig mirrors ModelsConfigSchema (model-registry.ts:256-263): an
// optional disabledProviders list plus a providers record keyed by provider id.
// Provider configs are kept as raw JSON here because neo's picker only needs
// the provider set and their disabled state; deeper fields are read later.
type ModelsConfig struct {
	DisabledProviders []string                   `json:"disabledProviders,omitempty"`
	Providers         map[string]json.RawMessage `json:"providers"`
}

// LoadModelsConfig reads <agentDir>/models.json. A missing file yields an empty
// config with no error (clean defaults). A present-but-corrupt file returns an
// error so callers can surface it, matching the classic CLI's up-front
// validation of models.json.
func LoadModelsConfig(agentDir string) (ModelsConfig, error) {
	path := filepath.Join(agentDir, "models.json")
	cfg := ModelsConfig{Providers: map[string]json.RawMessage{}}

	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return cfg, err
	}

	if err := json.Unmarshal(b, &cfg); err != nil {
		return ModelsConfig{Providers: map[string]json.RawMessage{}}, err
	}
	if cfg.Providers == nil {
		cfg.Providers = map[string]json.RawMessage{}
	}
	return cfg, nil
}
