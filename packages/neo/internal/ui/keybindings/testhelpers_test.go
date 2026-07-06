package keybindings

import "testing"

// withEnvT sets an env var (empty string means "unset") for the duration of fn,
// restoring the prior value after. It mirrors withEnv in keys.test.ts so the
// Windows-Terminal backspace heuristic can be exercised deterministically.
func withEnvT(t *testing.T, name, value string, fn func()) {
	t.Helper()
	if value == "" {
		t.Setenv(name, "")
		// t.Setenv cannot fully unset; emulate "undefined" by clearing to empty
		// AND recording that callers treat "" as absent. The matcher checks
		// os.Getenv(name) != "" so empty behaves as unset.
	} else {
		t.Setenv(name, value)
	}
	fn()
}

// withEnvVarsT applies several env vars for the duration of fn.
func withEnvVarsT(t *testing.T, vars map[string]string, fn func()) {
	t.Helper()
	for name, value := range vars {
		t.Setenv(name, value)
	}
	fn()
}
