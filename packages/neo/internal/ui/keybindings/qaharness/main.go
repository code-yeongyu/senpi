// Command qaharness is the manual-QA driver for the keybinding manager (plan
// task 6). It runs the verbatim scenario:
//
//	happy   - drive the manager with the scripted keys shift+tab / ctrl+o /
//	          ctrl+r (both as raw terminal sequences and as bubbletea v2
//	          KeyPressMsg events) and assert each resolves to the expected
//	          action (app.thinking.cycle / app.tools.expand / app.history.search).
//	failure - point the loader at a SANDBOX agent dir holding a MALFORMED
//	          keybindings.json and assert the manager warns + falls back to
//	          defaults, matching the classic behavior, with no crash.
//
// Isolation: it only ever reads a temp sandbox agent dir; the real ~/.senpi is
// never touched. It is NOT a package test; it is invoked by hand during QA and
// writes a machine-checkable report to stdout (PASS/FAIL lines + a final
// verdict).
package main

import (
	"fmt"
	"os"
	"path/filepath"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

type scriptedKey struct {
	label  string
	raw    string          // raw terminal sequence (legacy path)
	msg    tea.KeyPressMsg // bubbletea parsed event
	action string          // expected action id
}

func main() {
	failed := 0

	fmt.Println("== task-6 keybinding manager QA ==")

	// ---- HAPPY PATH: scripted keys resolve to actions ----
	m := keybindings.NewManager(nil)
	scripts := []scriptedKey{
		{"shift+tab", "\x1b[Z", tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift}, "app.thinking.cycle"},
		{"ctrl+o", "\x0f", tea.KeyPressMsg{Code: 'o', Mod: tea.ModCtrl}, "app.tools.expand"},
		{"ctrl+r", "\x12", tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl}, "app.history.search"},
	}
	for _, s := range scripts {
		rawOK := m.Matches(s.raw, s.action)
		msgOK := m.MatchesKeyMsg(s.msg, s.action)
		status := "PASS"
		if !rawOK || !msgOK {
			status = "FAIL"
			failed++
		}
		fmt.Printf("%s HAPPY %-9s raw=%v msg=%v -> %s\n", status, s.label, rawOK, msgOK, s.action)
	}

	// Scope determinism: ctrl+p differs by scope (editor cycles model, models
	// overlay toggles provider).
	ctrlP := tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl}
	editor := m.ResolveKeyMsgScoped(ctrlP, keybindings.ScopeEditor)
	models := m.ResolveKeyMsgScoped(ctrlP, keybindings.ScopeModels)
	scopeOK := has(editor, "app.model.cycleForward") && !has(editor, "app.models.toggleProvider") &&
		has(models, "app.models.toggleProvider") && !has(models, "app.model.cycleForward")
	if scopeOK {
		fmt.Printf("PASS HAPPY scope ctrl+p editor=%v models=%v\n", editor, models)
	} else {
		fmt.Printf("FAIL HAPPY scope ctrl+p editor=%v models=%v\n", editor, models)
		failed++
	}

	// ---- FAILURE PATH: malformed keybindings.json -> defaults, no crash ----
	sandbox, err := os.MkdirTemp("", "neo-keys-qa-")
	if err != nil {
		fmt.Printf("FAIL setup temp dir: %v\n", err)
		os.Exit(1)
	}
	defer func() {
		_ = os.RemoveAll(sandbox)
		fmt.Printf("CLEANUP removed sandbox %s\n", filepath.Base(sandbox))
	}()
	badPath := filepath.Join(sandbox, "keybindings.json")
	if err := os.WriteFile(badPath, []byte(`{ this is not valid json `), 0o644); err != nil {
		fmt.Printf("FAIL write malformed fixture: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("FIXTURE wrote malformed keybindings.json in sandbox %s\n", filepath.Base(sandbox))

	fm, loadErr := keybindings.Load(sandbox)
	if loadErr != nil {
		fmt.Printf("FAIL FAILURE Load returned error on malformed file: %v\n", loadErr)
		failed++
	} else {
		expand := fm.Keys("app.tools.expand")
		cycle := fm.Keys("app.thinking.cycle")
		if eq(expand, []string{"ctrl+o"}) && eq(cycle, []string{"shift+tab"}) {
			fmt.Printf("PASS FAILURE malformed -> defaults (app.tools.expand=%v app.thinking.cycle=%v)\n", expand, cycle)
		} else {
			fmt.Printf("FAIL FAILURE malformed did not restore defaults (expand=%v cycle=%v)\n", expand, cycle)
			failed++
		}
	}

	// Override fixture flips a binding, proving the reader path is live.
	if err := os.WriteFile(badPath, []byte(`{"app.tools.expand":"ctrl+x"}`), 0o644); err != nil {
		fmt.Printf("FAIL rewrite override fixture: %v\n", err)
		os.Exit(1)
	}
	om, _ := keybindings.Load(sandbox)
	if eq(om.Keys("app.tools.expand"), []string{"ctrl+x"}) {
		fmt.Printf("PASS OVERRIDE app.tools.expand flipped to ctrl+x\n")
	} else {
		fmt.Printf("FAIL OVERRIDE app.tools.expand = %v\n", om.Keys("app.tools.expand"))
		failed++
	}

	if failed == 0 {
		fmt.Println("VERDICT PASS")
	} else {
		fmt.Printf("VERDICT FAIL (%d checks failed)\n", failed)
		os.Exit(1)
	}
}

func has(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

func eq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
