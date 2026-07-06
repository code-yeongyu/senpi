// Command writeqa is a manual-QA receipt for the lockfile-replicating settings
// writer (plan task 4): it shows a live WriteNeoTheme call preserving the
// classic "theme" key and every unrelated field, writing ONLY neo.theme, in a
// throwaway sandbox. It proves the additive-only guardrail on a real file.
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
)

func main() {
	sb, err := os.MkdirTemp("", "neo-write-qa-")
	must(err)
	defer removeAll(sb)
	cwd, err := os.MkdirTemp("", "neo-write-cwd-")
	must(err)
	defer removeAll(cwd)

	sp := filepath.Join(sb, "settings.json")
	must(os.WriteFile(sp, []byte(`{"theme":"grok-day","defaultModel":"gpt-x","quietStartup":true}`), 0o644))
	fmt.Println("BEFORE:", readFile(sp))

	must(store.WriteNeoTheme(cwd, sb, store.ScopeGlobal, "grok-night"))
	fmt.Println("AFTER :", readFile(sp))

	// Assert the lock directory was released (no leak).
	if _, statErr := os.Stat(sp + ".lock"); !os.IsNotExist(statErr) {
		fmt.Println("FAIL: lock dir leaked")
		os.Exit(1)
	}

	s, err := store.LoadSettings(cwd, sb)
	must(err)
	fmt.Printf("READBACK classicTheme=%q neoTheme=%q effectiveNeo=%q defaultModel=%q\n",
		s.Theme, s.NeoTheme, s.EffectiveNeoTheme(), s.DefaultModel)

	if s.Theme != "grok-day" || s.NeoTheme != "grok-night" || s.DefaultModel != "gpt-x" {
		fmt.Println("RESULT FAIL")
		os.Exit(1)
	}
	fmt.Println("RESULT PASS: classic theme preserved, neo.theme added, siblings intact, lock released")
}

func readFile(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return "ERR:" + err.Error()
	}
	return string(b)
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "FATAL:", err)
		os.Exit(1)
	}
}

func removeAll(path string) {
	if err := os.RemoveAll(path); err != nil {
		fmt.Fprintln(os.Stderr, "cleanup warn:", err)
	}
}
