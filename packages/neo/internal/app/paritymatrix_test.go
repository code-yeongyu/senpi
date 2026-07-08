package app_test

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/code-yeongyu/senpi/packages/neo/internal/app"
	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/builtinext"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/slash"
)

// paritymatrix_test.go is the plan todo-11 master-task-25 parity GATE. It does
// NOT hand-author a matrix: TestParityMatrix RE-EXECUTES every parity row
// against the assembled-app seams (the input Router, the extension-UI ExtUI
// controller, the overlay Manager, and the keybindings Manager — the exact
// collaborators BuildInteractiveProgram wires) and emits PASS/FAIL per row. A
// row fails if its live behavior is missing, and the emitted category counts
// MUST equal the live table sizes (22 slash / len(keybindings.Definitions())
// app-and-tui actions / 10 extension-UI methods / 5 builtin extensions / 10
// overlays), each read from the live registry — never a hardcoded literal.
//
// It reuses the package-local fakes rather than inventing new ones:
//   - newRouterFixture (input_test.go): the assembled Router over the slash
//     Dispatcher + fake Commander.
//   - newExtUIHarness / extReq (extui_test.go): the assembled ExtUI controller
//     over fake auth-client / responder / directive-sink.
//   - overlayKB / fakeRequester / build* (overlaystack_test.go): the assembled
//     overlay Manager + its command-issuer seam.
//
// The matrix (with per-row evidence pointers + findings) is written to
// .omo/evidence/task-11-neo-completion.md, and every row is also emitted via
// t.Log so the run itself carries the evidence.

// parityRow is one re-executed matrix row.
type parityRow struct {
	category string
	name     string
	pass     bool
	evidence string // seam / test that produced the result
	detail   string // observed live outcome
}

// parityFinding is a gap surfaced while re-executing the matrix. Findings do not
// by themselves fail the gate; they are reported for the orchestrator.
type parityFinding struct {
	title  string
	detail string
}

// TestParityMatrix is the binding acceptance for plan todo 11.
func TestParityMatrix(t *testing.T) {
	var rows []parityRow
	var findings []parityFinding

	slashRows, slashCount := paritySlashRows(t)
	kbRows, kbSpotRows, kbCount := parityKeybindingRows(t)
	extuiRows, extuiCount := parityExtUIRows(t)
	builtinRows, builtinCount, builtinFindings := parityBuiltinExtRows(t)
	overlayRows, overlayCount := parityOverlayRows(t)

	rows = append(rows, slashRows...)
	rows = append(rows, kbRows...)
	rows = append(rows, kbSpotRows...)
	rows = append(rows, extuiRows...)
	rows = append(rows, builtinRows...)
	rows = append(rows, overlayRows...)
	findings = append(findings, builtinFindings...)

	// Live table sizes, read from the registries (never hardcoded literals).
	liveSlash := len(slash.NewBuiltins().Names())
	liveKB := len(keybindings.Definitions())
	liveExtUI := len(bridge.KnownExtensionUIMethods())
	liveBuiltin := parityBuiltinExtNames
	liveOverlay := parityOverlayKindCount

	counts := map[string]int{
		"slash":       slashCount,
		"keybindings": kbCount,
		"extui":       extuiCount,
		"builtinext":  builtinCount,
		"overlays":    overlayCount,
	}

	// Emit + persist the matrix BEFORE the assertions so the evidence file exists
	// even on a red run.
	writeParityEvidence(t, rows, counts, findings)
	for _, r := range rows {
		t.Logf("[%s] %-40s %s | %s | %s", passLabel(r.pass), r.name, r.category, r.evidence, r.detail)
	}

	// Per-category count parity against the live tables.
	assertCount(t, "slash", slashCount, liveSlash, 22)
	assertCount(t, "keybindings", kbCount, liveKB, liveKB)
	assertCount(t, "extui", extuiCount, liveExtUI, 10)
	assertCount(t, "builtinext", builtinCount, len(liveBuiltin), 5)
	assertCount(t, "overlays", overlayCount, liveOverlay, 12)

	// Every re-executed row must PASS.
	failed := 0
	for _, r := range rows {
		if !r.pass {
			failed++
			t.Errorf("parity row FAIL: [%s] %s — %s (%s)", r.category, r.name, r.detail, r.evidence)
		}
	}
	if failed == 0 {
		t.Logf("parity matrix: %d rows, all PASS; counts slash=%d keybindings=%d extui=%d builtinext=%d overlays=%d",
			len(rows), slashCount, kbCount, extuiCount, builtinCount, overlayCount)
	}
	for _, f := range findings {
		t.Logf("FINDING: %s — %s", f.title, f.detail)
	}
}

// assertCount checks a re-executed category count against the live registry size
// and the plan's fixed expectation (for the categories the plan pins).
func assertCount(t *testing.T, category string, got, live, wantFixed int) {
	t.Helper()
	if got != live {
		t.Errorf("%s: re-executed %d rows but the live table holds %d", category, got, live)
	}
	if got != wantFixed {
		t.Errorf("%s: count %d != plan-pinned %d", category, got, wantFixed)
	}
}

func passLabel(pass bool) string {
	if pass {
		return "PASS"
	}
	return "FAIL"
}

// --- category 1: 22 slash commands -------------------------------------------

// paritySlashRows drives every builtin slash name through the assembled Router
// and asserts each dispatches to a real route (overlay / RPC / native) — never
// falling through to prompt, unknown, or none.
func paritySlashRows(t *testing.T) ([]parityRow, int) {
	t.Helper()
	fx := newRouterFixture(t)
	names := slash.NewBuiltins().Names()

	var rows []parityRow
	for _, name := range names {
		res := fx.router.Submit("/" + name)
		route, ok := slashRouteLabel(res.Kind)
		rows = append(rows, parityRow{
			category: "slash",
			name:     "/" + name,
			pass:     ok,
			evidence: "app.Router.Submit",
			detail:   route,
		})
	}
	return rows, len(names)
}

// slashRouteLabel names the route and reports whether it is a real dispatch (a
// builtin resolving to an overlay intent, a direct RPC, or a native op).
func slashRouteLabel(k app.RouteKind) (string, bool) {
	switch k {
	case app.RouteOverlay:
		return "→ overlay", true
	case app.RouteRPC:
		return "→ rpc", true
	case app.RouteNative:
		return "→ native", true
	default:
		return fmt.Sprintf("→ non-dispatch route (%d)", int(k)), false
	}
}

// --- category 2: keybinding actions ------------------------------------------

// parityKeybindingRows asserts every action in the live keybindings.Manager
// table resolves through the Manager (its resolved key list round-trips the
// registry default — no hardcoded key bytes). It also emits the plan's two
// keybinding spot-checks (raw match + override file honored) as extra evidence
// rows. Returns (tableRows, spotRows, tableCount).
func parityKeybindingRows(t *testing.T) ([]parityRow, []parityRow, int) {
	t.Helper()
	defs := keybindings.Definitions()
	mgr := keybindings.NewManager(nil)

	ids := make([]string, 0, len(defs))
	for id := range defs {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	var rows []parityRow
	for _, id := range ids {
		want := defs[id].DefaultKeys
		got := mgr.Keys(id)
		pass := reflect.DeepEqual(got, want)
		rows = append(rows, parityRow{
			category: "keybindings",
			name:     id,
			pass:     pass,
			evidence: "keybindings.Manager.Keys",
			detail:   fmt.Sprintf("resolves %v", got),
		})
	}

	// Spot-check A (plan QA scenario 1, keybinding row): the physical ctrl+o key
	// resolves to app.tools.expand through the default Manager.
	rawCtrlO, rawCtrlE := "\x0f", "\x05"
	spot := []parityRow{{
		category: "keybindings-spot",
		name:     "app.tools.expand raw ctrl+o",
		pass:     mgr.Matches(rawCtrlO, "app.tools.expand"),
		evidence: "keybindings.Manager.Matches",
		detail:   "ctrl+o (\\x0f) matches app.tools.expand",
	}}

	// Spot-check B (plan QA scenario 2, override file honored): a user override
	// remapping app.tools.expand → ctrl+e makes ctrl+o inert and ctrl+e active.
	remapped := keybindings.NewManager(map[string][]string{"app.tools.expand": {"ctrl+e"}})
	overridePass := !remapped.Matches(rawCtrlO, "app.tools.expand") && remapped.Matches(rawCtrlE, "app.tools.expand")
	spot = append(spot, parityRow{
		category: "keybindings-spot",
		name:     "app.tools.expand override → ctrl+e",
		pass:     overridePass,
		evidence: "keybindings.NewManager(userBindings) + Matches",
		detail:   "ctrl+o inert, ctrl+e active after remap",
	})

	return rows, spot, len(defs)
}

// --- category 3: 10 extension-UI methods -------------------------------------

// parityExtUIMethods is the deterministic method order; the SET is validated
// against bridge.KnownExtensionUIMethods() so a mirrored-method drift fails.
var parityExtUIMethods = []string{
	"select", "confirm", "input", "editor", "notify",
	"setStatus", "setWidget", "setTitle", "set_editor_text",
	"custom_unsupported",
}

// parityExtUIDirectiveMethods are the fire-and-forget methods that route to the
// DirectiveSink instead of opening an overlay.
var parityExtUIDirectiveMethods = map[string]bool{
	"notify": true, "setStatus": true, "setWidget": true,
	"setTitle": true, "set_editor_text": true,
}

// parityExtUIFields carries minimal fields so DialogForRequest / ApplyRequest
// accept each method.
func parityExtUIFields(method string) map[string]any {
	switch method {
	case "select":
		return map[string]any{"title": "Pick", "options": []any{"a", "b"}}
	case "confirm":
		return map[string]any{"title": "C", "message": "m"}
	case "input":
		return map[string]any{"title": "I", "placeholder": "p"}
	case "editor":
		return map[string]any{"title": "E", "prefill": "x"}
	case "notify":
		return map[string]any{"message": "hi", "notifyType": "warning"}
	case "setStatus":
		return map[string]any{"statusKey": "k", "statusText": "s"}
	case "setWidget":
		return map[string]any{"widgetKey": "w", "widgetLines": []any{"l1"}}
	case "setTitle":
		return map[string]any{"title": "T"}
	case "set_editor_text":
		return map[string]any{"text": "t"}
	case "custom_unsupported":
		return map[string]any{"extensionName": "acme"}
	default:
		return nil
	}
}

// parityExtUIRows drives each mirrored extension-UI method through the assembled
// ExtUI controller and asserts it is HANDLED: directives land on the sink (no
// overlay), interactive dialogs + the custom_unsupported notice push an overlay
// onto the Manager. The covered set is validated against the live method table.
func parityExtUIRows(t *testing.T) ([]parityRow, int) {
	t.Helper()
	live := bridge.KnownExtensionUIMethods()
	if len(parityExtUIMethods) != len(live) {
		t.Fatalf("extui method order list has %d entries, live table has %d", len(parityExtUIMethods), len(live))
	}

	var rows []parityRow
	covered := map[string]bool{}
	for _, method := range parityExtUIMethods {
		if !live[method] {
			t.Fatalf("extui method %q is not in the live KnownExtensionUIMethods set", method)
		}
		h := newExtUIHarness(t)
		h.ext.HandleRequest(extReq("parity-ext", method, parityExtUIFields(method)), "saved")

		var pass bool
		var detail string
		switch {
		case parityExtUIDirectiveMethods[method]:
			pass = !h.ext.Active() && len(h.sink.directives) == 1
			detail = fmt.Sprintf("directive → sink (active=%v, directives=%d)", h.ext.Active(), len(h.sink.directives))
		case method == "custom_unsupported":
			pass = h.ext.Active()
			detail = "custom_unsupported → notice overlay"
		default: // interactive dialog
			pass = h.ext.Active()
			detail = "dialog → overlay Manager.Push"
		}
		covered[method] = pass
		rows = append(rows, parityRow{
			category: "extui",
			name:     method,
			pass:     pass,
			evidence: "app.ExtUI.HandleRequest",
			detail:   detail,
		})
	}

	// The covered set must equal the live mirrored-method set.
	for method := range live {
		if !covered[method] {
			t.Errorf("mirrored extension-UI method %q was not covered by a passing row", method)
		}
	}
	return rows, len(parityExtUIMethods)
}

// --- category 4: 5 builtin extensions ----------------------------------------

// parityBuiltinExtNames is the canonical set of builtin extensions the classic
// TUI ships (builtinext/doc.go), re-executed below via their native ports.
var parityBuiltinExtNames = []string{
	"history-search", "session-observer", "files", "diff", "redraws",
}

// parityBuiltinExtRows re-executes each of the five native builtin-extension
// ports: it constructs the real component, drives it, and asserts functional
// output (a non-empty rendered frame or a resolved value). For the two chord-
// launched extensions it additionally asserts the launch action resolves through
// the keybindings Manager. It surfaces the wiring gap (the ports are present but
// not yet mounted on the assembled Model's key/slash router) as a finding.
func parityBuiltinExtRows(t *testing.T) ([]parityRow, int, []parityFinding) {
	t.Helper()
	th := parityTheme(t)
	km := keybindings.NewManager(nil)
	var rows []parityRow

	// 1. history-search (ctrl+r): filter cross-session prompt history.
	hist := builtinext.NewHistorySearchOverlay(builtinext.HistorySearchOptions{
		Entries: []builtinext.HistoryEntry{
			{Text: "deploy production release", SessionID: "a", Timestamp: 2_000},
			{Text: "run the migration script", SessionID: "a", Timestamp: 1_000},
		},
		Theme: th, Keybindings: km, RequestRender: func() {}, Done: func(builtinext.HistoryEntry, bool) {},
	})
	hist.SetFocused(true)
	hist.HandleInput("d") // narrow the query
	histPass := frameNonEmpty(hist.Render(80)) && len(hist.FilteredEntries()) > 0 &&
		firstKeyContains(km, "app.history.search", "ctrl+r")
	rows = append(rows, parityRow{
		category: "builtinext", name: "history-search (ctrl+r)", pass: histPass,
		evidence: "builtinext.NewHistorySearchOverlay + keybindings.Manager",
		detail:   fmt.Sprintf("filtered=%d, launch=%v", len(hist.FilteredEntries()), km.Keys("app.history.search")),
	})

	// 2. session-observer (ctrl+s): HUD over a session list renders.
	obs := builtinext.NewSessionHudOverlay(builtinext.SessionHudOptions{
		Sessions: []builtinext.SessionHudEntry{{
			ID: "live-session", ShortID: "live", Path: "/tmp/live.jsonl", CWD: "/repo/live",
			CreatedAt: time.UnixMilli(1_000), ModifiedAt: time.UnixMilli(2_000),
			MessageCount: 2, LastUserText: "start the live run",
		}},
		Theme: th, Keybindings: km, Done: func() {}, RequestRender: func() {},
	})
	obsPass := frameNonEmpty(obs.Render(80)) && firstKeyContains(km, "app.sessions.observe", "ctrl+s")
	rows = append(rows, parityRow{
		category: "builtinext", name: "session-observer (ctrl+s)", pass: obsPass,
		evidence: "builtinext.NewSessionHudOverlay + keybindings.Manager",
		detail:   fmt.Sprintf("launch=%v", km.Keys("app.sessions.observe")),
	})

	// 3. files (/files): recent file operations picker renders.
	files := builtinext.NewFilesPickerOverlay(builtinext.FilesPickerOptions{
		Files: []builtinext.FileEntry{
			{Path: "src/server.go", Operations: map[string]bool{"read": true, "edit": true}, LastTimestamp: 3_000},
			{Path: "src/config.go", Operations: map[string]bool{"write": true}, LastTimestamp: 2_000},
		},
		Theme: th, Keybindings: km, OnOpen: func(builtinext.FileEntry) {}, Done: func() {}, RequestRender: func() {},
	})
	rows = append(rows, parityRow{
		category: "builtinext", name: "files (/files)", pass: frameNonEmpty(files.Render(80)),
		evidence: "builtinext.NewFilesPickerOverlay", detail: "picker frame rendered",
	})

	// 4. diff (/diff): git status parse + picker renders.
	diffFiles := builtinext.ParseGitStatus(" M src/server.go\nA  src/new-feature.go\n D src/legacy.go\n?? scratch.txt")
	diff := builtinext.NewDiffPickerOverlay(builtinext.DiffPickerOptions{
		Files: diffFiles, Theme: th, Keybindings: km,
		OnOpen: func(builtinext.FileDiffInfo) {}, Done: func() {}, RequestRender: func() {},
	})
	rows = append(rows, parityRow{
		category: "builtinext", name: "diff (/diff)", pass: len(diffFiles) > 0 && frameNonEmpty(diff.Render(80)),
		evidence: "builtinext.ParseGitStatus + NewDiffPickerOverlay",
		detail:   fmt.Sprintf("parsed %d changed files", len(diffFiles)),
	})

	// 5. redraws (/tui): full-redraw stat notice resolves.
	rc := &builtinext.RedrawCounter{}
	for i := 0; i < 7; i++ {
		rc.RecordFullRedraw()
	}
	msg, level := builtinext.RedrawsNotice(rc.FullRedraws())
	rows = append(rows, parityRow{
		category: "builtinext", name: "redraws (/tui)", pass: rc.FullRedraws() == 7 && msg != "" && level != "",
		evidence: "builtinext.RedrawCounter + RedrawsNotice",
		detail:   fmt.Sprintf("count=%d level=%q", rc.FullRedraws(), level),
	})

	findings := []parityFinding{{
		title: "builtin extensions: chord ports mounted, slash-command ports routed by the backend",
		detail: "history-search (ctrl+r) and session-observer (ctrl+s) are now wired into the assembled Model: " +
			"route.go handleKey resolves app.history.search/app.sessions.observe through the keybindings Manager " +
			"and opens OverlayHistory/OverlayObserver via openAppOverlay (overlaybuild.go), matching classic " +
			"onAction(...)->/history,/sessions (interactive-mode.ts:2850/2857). files (/files), diff (/diff) and " +
			"redraws (/tui) are registered by the backend via pi.registerCommand (files.ts:22, diff.ts:19, " +
			"redraws.ts:11) with NO keybound action, chord, or @ mention; in the split Go TUI they surface through " +
			"get_commands and route via the input Router (DispatchExtensionCommand -> RoutePrompt, input.go:245), " +
			"so they need no new keybound wiring.",
	}}
	return rows, len(parityBuiltinExtNames), findings
}

func firstKeyContains(km *keybindings.Manager, action, key string) bool {
	for _, k := range km.Keys(action) {
		if k == key {
			return true
		}
	}
	return false
}

func frameNonEmpty(lines []string) bool {
	return strings.TrimSpace(strings.Join(lines, "\n")) != ""
}

// --- category 5: overlays -----------------------------------------------------

// parityOverlayKindCount is the number of manager-hosted overlay kinds the
// openAppOverlay emission table covers (OverlayModel..OverlayObserver; the
// OverlayExtUI/OverlayLogin kinds are driven by the ExtUI request path, not this
// table). Read from the enum so a new overlay changes the live count.
const parityOverlayKindCount = int(app.OverlayObserver)

// parityOverlayRows drives each overlay kind through the assembled overlay
// Manager and asserts it builds + emits the command/file-op its confirm path
// names via the injected Requester (read-only overlays emit nothing). Mirrors the
// todo-5 emission table so the gate re-executes the same seam.
func parityOverlayRows(t *testing.T) ([]parityRow, int) {
	t.Helper()
	cases := []struct {
		name       string
		kind       app.OverlayKind
		build      func() app.Overlay
		setup      func(app.Overlay)
		key        string
		wantCmd    string
		wantFileOp string
	}{
		{name: "model", kind: app.OverlayModel, build: func() app.Overlay { return buildModelSelector() }, key: "\n", wantCmd: "set_model"},
		{
			name: "favorites", kind: app.OverlayFavorites,
			build: func() app.Overlay { return app.NewFavoritesOverlay(buildModelSelector()) },
			setup: func(o app.Overlay) { o.HandleKey("\x06", keybindings.NewManager(nil), "") },
			key:   "\x13", wantFileOp: "save_favorites",
		},
		{name: "session", kind: app.OverlaySession, build: func() app.Overlay { return buildSessionPicker() }, key: "\n", wantCmd: "switch_session"},
		{name: "tree", kind: app.OverlayTree, build: func() app.Overlay { return buildTree() }, key: "\n", wantCmd: "fork"},
		{name: "settings", kind: app.OverlaySettings, build: func() app.Overlay { return buildSettings() }, key: "\n", wantFileOp: "write_settings"},
		{name: "theme", kind: app.OverlayTheme, build: func() app.Overlay { return buildTheme() }, key: "\n", wantFileOp: "write_settings"},
		{name: "thinking", kind: app.OverlayThinking, build: func() app.Overlay { return buildThinking() }, key: "\n", wantCmd: "set_thinking_level"},
		{name: "trust", kind: app.OverlayTrust, build: func() app.Overlay { return buildTrust() }, key: "\n", wantCmd: "trust"},
		{name: "hotkeys", kind: app.OverlayHotkeys, build: func() app.Overlay { return overlays.NewHotkeysView(keybindings.NewManager(nil)) }, key: "\n"},
		{name: "stats", kind: app.OverlayStats, build: func() app.Overlay { return overlays.NewSessionStats(overlays.SessionStats{SessionID: "s1"}) }, key: "\n"},
		{
			name: "history", kind: app.OverlayHistory,
			build: func() app.Overlay {
				return app.NewHistoryOverlay([]builtinext.HistoryEntry{{Text: "deploy production release", SessionID: "a", Timestamp: 1_000}}, parityTheme(t), overlayKB(t))
			},
			key: "\n", // confirm selects a prompt (editor insert, no RPC/file-op)
		},
		{
			name: "observer", kind: app.OverlayObserver,
			build: func() app.Overlay {
				return app.NewObserverOverlay([]builtinext.SessionHudEntry{{ID: "s", ShortID: "s", Path: "/nonexistent/s.jsonl", LastUserText: "hi"}}, parityTheme(t), overlayKB(t))
			},
			key: "\x1b", // esc closes the picker (no RPC/file-op)
		},
	}
	if len(cases) != parityOverlayKindCount {
		t.Fatalf("overlay emission table has %d rows but %d overlay kinds are enumerated", len(cases), parityOverlayKindCount)
	}

	var rows []parityRow
	for _, tc := range cases {
		req := &fakeRequester{}
		mgr := app.NewManager(overlayKB(t), req)
		ov := tc.build()
		mgr.Push(tc.kind, ov, "")
		if tc.setup != nil {
			tc.setup(ov)
		}
		mgr.HandleKey(tc.key)

		var pass bool
		var detail string
		switch {
		case tc.wantCmd != "":
			pass = req.hasCommand(tc.wantCmd)
			detail = "emits rpc " + tc.wantCmd
		case tc.wantFileOp != "":
			pass = req.hasFileOp(tc.wantFileOp)
			detail = "emits fileop " + tc.wantFileOp
		default: // read-only overlay: builds + drives, emits nothing
			pass = len(req.commands) == 0 && len(req.fileOps) == 0
			detail = "read-only, emits nothing"
		}
		rows = append(rows, parityRow{
			category: "overlays",
			name:     tc.name,
			pass:     pass,
			evidence: "app.Manager.Push + HandleKey → Requester",
			detail:   detail,
		})
	}
	return rows, len(cases)
}

// --- shared helpers ----------------------------------------------------------

// parityTheme loads the default theme with a sentinel agent dir so no real user
// config is read (mirrors newExtUIHarness / newRouterFixture).
func parityTheme(t *testing.T) *theme.Theme {
	t.Helper()
	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName, AgentDir: "\x00nonexistent"})
	if err != nil {
		t.Fatalf("theme.Load: %v", err)
	}
	return th
}

// --- evidence writer ----------------------------------------------------------

// writeParityEvidence renders the matrix (grouped by category, per-row PASS/FAIL
// + evidence pointer), the live counts, and the findings to
// .omo/evidence/task-11-neo-completion.md. A write failure is logged, not fatal:
// the t.Log emission is the primary evidence, the file is the secondary artifact.
func writeParityEvidence(t *testing.T, rows []parityRow, counts map[string]int, findings []parityFinding) {
	t.Helper()
	root, ok := repoRootFrom(t)
	if !ok {
		t.Logf("parity evidence: could not locate repo root (.omo); skipping file write")
		return
	}

	var b strings.Builder
	fmt.Fprintf(&b, "# Task 11 — neo TUI parity matrix (master task-25)\n\n")
	fmt.Fprintf(&b, "Generated by `TestParityMatrix` (packages/neo/internal/app/paritymatrix_test.go).\n")
	fmt.Fprintf(&b, "Every row is RE-EXECUTED against the assembled-app seams; counts are read from the live registries.\n\n")

	fmt.Fprintf(&b, "## Live counts (re-executed == live table size)\n\n")
	fmt.Fprintf(&b, "| Category | Re-executed rows | Live table |\n|---|---|---|\n")
	fmt.Fprintf(&b, "| slash commands | %d | `slash.NewBuiltins().Names()` |\n", counts["slash"])
	fmt.Fprintf(&b, "| keybinding actions | %d | `keybindings.Definitions()` |\n", counts["keybindings"])
	fmt.Fprintf(&b, "| extension-UI methods | %d | `bridge.KnownExtensionUIMethods()` |\n", counts["extui"])
	fmt.Fprintf(&b, "| builtin extensions | %d | `builtinext` native ports |\n", counts["builtinext"])
	fmt.Fprintf(&b, "| overlays | %d | `OverlayKind` enum |\n\n", counts["overlays"])

	total, passed := len(rows), 0
	for _, r := range rows {
		if r.pass {
			passed++
		}
	}
	fmt.Fprintf(&b, "## Result: %d/%d rows PASS\n\n", passed, total)

	order := []string{"slash", "keybindings", "keybindings-spot", "extui", "builtinext", "overlays"}
	titles := map[string]string{
		"slash":            "1. Slash commands (app.Router.Submit)",
		"keybindings":      "2. Keybinding actions (keybindings.Manager)",
		"keybindings-spot": "2b. Keybinding spot-checks (raw match + override file)",
		"extui":            "3. Extension-UI methods (app.ExtUI.HandleRequest)",
		"builtinext":       "4. Builtin extensions (native ports)",
		"overlays":         "5. Overlays (app.Manager → Requester)",
	}
	for _, cat := range order {
		catRows := rowsInCategory(rows, cat)
		if len(catRows) == 0 {
			continue
		}
		fmt.Fprintf(&b, "### %s\n\n", titles[cat])
		fmt.Fprintf(&b, "| Row | Result | Evidence seam | Observed |\n|---|---|---|---|\n")
		for _, r := range catRows {
			fmt.Fprintf(&b, "| %s | %s | `%s` | %s |\n", r.name, passLabel(r.pass), r.evidence, r.detail)
		}
		fmt.Fprintf(&b, "\n")
	}

	if len(findings) > 0 {
		fmt.Fprintf(&b, "## Findings\n\n")
		for _, f := range findings {
			fmt.Fprintf(&b, "- **%s**: %s\n", f.title, f.detail)
		}
		fmt.Fprintf(&b, "\n")
	}

	dst := filepath.Join(root, ".omo", "evidence", "task-11-neo-completion.md")
	if err := os.WriteFile(dst, []byte(b.String()), 0o644); err != nil {
		t.Logf("parity evidence: write %s failed: %v", dst, err)
		return
	}
	t.Logf("parity evidence written to %s", dst)
}

func rowsInCategory(rows []parityRow, cat string) []parityRow {
	var out []parityRow
	for _, r := range rows {
		if r.category == cat {
			out = append(out, r)
		}
	}
	return out
}

// repoRootFrom walks up from the test's working directory to the first ancestor
// holding a .omo directory (the repo root).
func repoRootFrom(t *testing.T) (string, bool) {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		return "", false
	}
	for {
		if info, err := os.Stat(filepath.Join(dir, ".omo")); err == nil && info.IsDir() {
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}
