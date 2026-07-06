package slash

import (
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
)

func testTheme(t *testing.T) *theme.Theme {
	t.Helper()
	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	if err != nil {
		t.Fatalf("theme.Load: %v", err)
	}
	return th
}

// TestBashCommandProducesRPC asserts the bash dispatch maps to the RPC bash
// command with the parsed command + excludeFromContext flag (rpc-types.ts:53).
func TestBashCommandRPC(t *testing.T) {
	cmd := BashCommand("ls -la", false)
	if cmd.Type != "bash" {
		t.Fatalf("type = %q, want bash", cmd.Type)
	}
	if cmd.Fields["command"] != "ls -la" {
		t.Fatalf("command = %v", cmd.Fields["command"])
	}
	if _, ok := cmd.Fields["excludeFromContext"]; ok {
		t.Fatalf("excludeFromContext should be omitted when false")
	}
	excluded := BashCommand("echo hi", true)
	if excluded.Fields["excludeFromContext"] != true {
		t.Fatalf("excludeFromContext = %v, want true", excluded.Fields["excludeFromContext"])
	}
}

// TestAbortBashRPC asserts the abort path (Esc while running) → abort_bash.
func TestAbortBashRPC(t *testing.T) {
	cmd := AbortBashCommand()
	if cmd.Type != "abort_bash" {
		t.Fatalf("type = %q, want abort_bash", cmd.Type)
	}
}

// TestBashBlockHeaderStyling asserts the streaming output block renders the grok
// bash header `$ <command>` with the bashMode (green) accent, mirroring
// bash-execution.ts formatCommandHeader. The excluded (!!) variant uses the dim
// color instead. We assert on the plain header text + which style token wraps
// the prompt so the color choice is verified, not the raw escapes.
func TestBashBlockHeader(t *testing.T) {
	th := testTheme(t)

	block := NewBashBlock("ls -la", false, th)
	header := block.HeaderPlain()
	if !strings.HasPrefix(header, "$ ") {
		t.Fatalf("header = %q, want '$ ' prefix", header)
	}
	if !strings.Contains(header, "ls -la") {
		t.Fatalf("header = %q, want command text", header)
	}
	// The bashMode color is the accent-green token (dark.json bashMode: "green").
	if block.PromptColorHex() != th.AccentGreenHex() {
		t.Fatalf("prompt color = %q, want green %q", block.PromptColorHex(), th.AccentGreenHex())
	}

	excluded := NewBashBlock("echo hi", true, th)
	if excluded.PromptColorHex() == th.AccentGreenHex() {
		t.Fatalf("excluded (!!) prompt should be dim, not green")
	}
	if excluded.PromptColorHex() != th.TextMutedHex() && excluded.PromptColorHex() != th.Palette().TextDim {
		t.Fatalf("excluded prompt color = %q, want dim", excluded.PromptColorHex())
	}
}

// TestBashBlockStreaming asserts appended output accumulates with incomplete
// line continuation semantics (bash-execution.ts appendOutput:90-106): the first
// chunk of a new append continues the last line.
func TestBashBlockStreaming(t *testing.T) {
	th := testTheme(t)
	block := NewBashBlock("run", false, th)
	block.AppendOutput("line1\nline")
	block.AppendOutput("2\nline3")
	out := block.OutputLines()
	want := []string{"line1", "line2", "line3"}
	if len(out) != len(want) {
		t.Fatalf("lines = %v, want %v", out, want)
	}
	for i := range want {
		if out[i] != want[i] {
			t.Fatalf("line %d = %q, want %q", i, out[i], want[i])
		}
	}
}

// TestBashBlockStripsAnsi asserts ANSI escapes and CR are stripped from streamed
// output (bash-execution.ts appendOutput strips ansi + normalizes CRLF).
func TestBashBlockStripsAnsi(t *testing.T) {
	th := testTheme(t)
	block := NewBashBlock("run", false, th)
	block.AppendOutput("\x1b[31mred\x1b[0m\r\nplain\r")
	out := block.OutputLines()
	if len(out) < 2 || out[0] != "red" || out[1] != "plain" {
		t.Fatalf("stripped output = %v, want [red plain]", out)
	}
}

// TestBashBlockStatus asserts completion status text: exit-0 clean, non-zero
// shows "(exit N)", cancelled shows "(cancelled)" (bash-execution.ts:199-203).
func TestBashBlockStatus(t *testing.T) {
	th := testTheme(t)

	ok := NewBashBlock("run", false, th)
	ok.SetComplete(0, false)
	if s := ok.StatusPlain(); strings.Contains(s, "exit") || strings.Contains(s, "cancelled") {
		t.Fatalf("exit-0 status = %q, want clean", s)
	}

	fail := NewBashBlock("run", false, th)
	fail.SetComplete(2, false)
	if s := fail.StatusPlain(); !strings.Contains(s, "(exit 2)") {
		t.Fatalf("exit-2 status = %q, want (exit 2)", s)
	}

	cancelled := NewBashBlock("run", false, th)
	cancelled.SetComplete(0, true)
	if s := cancelled.StatusPlain(); !strings.Contains(s, "(cancelled)") {
		t.Fatalf("cancelled status = %q, want (cancelled)", s)
	}
}
