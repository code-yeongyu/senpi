package terminalimage

// Ported contract from packages/tui/test/terminal-image.test.ts. Each Go test
// name maps to a describe/it block there; the mapping table lives in
// .omo/evidence/task-9-neo-go-tui.md. These tests are written RED first: the
// terminalimage package is empty until the GREEN implementation lands.

import (
	"strings"
	"testing"
)

// envKeys mirrors the ENV_KEYS array the TS suite clears before each case.
var envKeys = []string{
	"TERM", "TERM_PROGRAM", "TERMINAL_EMULATOR", "COLORTERM", "TMUX",
	"KITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR", "WEZTERM_PANE",
	"ITERM_SESSION_ID", "WT_SESSION", "CMUX_WORKSPACE_ID",
	"WARP_SESSION_ID", "WARP_TERMINAL_SESSION_UUID",
}

// withEnv clears every capability env var, applies overrides, runs fn, then
// restores. Mirrors terminal-image.test.ts withEnv.
func withEnv(t *testing.T, overrides map[string]string, fn func()) {
	t.Helper()
	for _, k := range envKeys {
		t.Setenv(k, "") // record original for restore via t.Setenv semantics
		_ = k
	}
	// t.Setenv sets to "" which is different from unset; the detector treats ""
	// as absent (empty string). Apply overrides on top.
	unsetAll(envKeys)
	for k, v := range overrides {
		setEnv(k, v)
	}
	defer unsetAll(envKeys)
	fn()
}

// -----------------------------------------------------------------------------
// isImageLine — iTerm2 image protocol
// -----------------------------------------------------------------------------

func TestIsImageLine_ITerm2(t *testing.T) {
	cases := []struct {
		name string
		line string
	}{
		{"start of line", "\x1b]1337;File=size=100,100;inline=1:base64encodeddata==\x07"},
		{"text before it", "Some text \x1b]1337;File=size=100,100;inline=1:base64data==\x07 more text"},
		{"middle of long line", "Text before image..." + "\x1b]1337;File=inline=1:verylongbase64data==" + "...text after"},
		{"end of line", "Regular text ending with \x1b]1337;File=inline=1:base64data==\x07"},
		{"minimal sequence", "\x1b]1337;File=:\x07"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if !IsImageLine(tc.line) {
				t.Fatalf("IsImageLine(%q) = false, want true", tc.line)
			}
		})
	}
}

// -----------------------------------------------------------------------------
// isImageLine — Kitty image protocol
// -----------------------------------------------------------------------------

func TestIsImageLine_Kitty(t *testing.T) {
	cases := []struct {
		name string
		line string
	}{
		{"start of line", "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\"},
		{"text before it", "Output: \x1b_Ga=T,f=100;data...\x1b\\\x1b_Gm=i=1;\x1b\\"},
		{"with padding", "  \x1b_Ga=T,f=100...\x1b\\\x1b_Gm=i=1;\x1b\\  "},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if !IsImageLine(tc.line) {
				t.Fatalf("IsImageLine(%q) = false, want true", tc.line)
			}
		})
	}
}

// -----------------------------------------------------------------------------
// isImageLine — Bug regression tests
// -----------------------------------------------------------------------------

func TestIsImageLine_BugRegressions(t *testing.T) {
	longLine := "Text prefix " + "\x1b]1337;File=size=800,600;inline=1:" +
		strings.Repeat(strings.Repeat("A", 100), 3000) + " suffix"
	if len(longLine) <= 300000 {
		t.Fatalf("test fixture too short: %d", len(longLine))
	}
	cases := []struct {
		name string
		line string
	}{
		{"very long line 304k+", longLine},
		{"terminal without image support", "Read image file [image/jpeg]\x1b]1337;File=inline=1:base64data==\x07"},
		{"ansi codes before", "\x1b[31mError output \x1b]1337;File=inline=1:image==\x07"},
		{"ansi codes after", "\x1b_Ga=T,f=100:data...\x1b\\\x1b_Gm=i=1;\x1b\\\x1b[0m reset"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if !IsImageLine(tc.line) {
				t.Fatalf("IsImageLine(...) = false, want true")
			}
		})
	}
}

// -----------------------------------------------------------------------------
// isImageLine — Negative cases
// -----------------------------------------------------------------------------

func TestIsImageLine_Negatives(t *testing.T) {
	cases := []struct {
		name string
		line string
	}{
		{"plain text", "This is just a regular text line without any escape sequences"},
		{"only ansi codes", "\x1b[31mRed text\x1b[0m and \x1b[32mgreen text\x1b[0m"},
		{"cursor movement codes", "\x1b[1A\x1b[2KLine cleared and moved up"},
		{"partial iterm2", "Some text with ]1337;File but missing ESC at start"},
		{"partial kitty", "Some text with _G but missing ESC at start"},
		{"empty line", ""},
		{"newline only", "\n"},
		{"two newlines", "\n\n"},
		{"file path with keywords", "/path/to/File_1337_backup/image.jpg"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if IsImageLine(tc.line) {
				t.Fatalf("IsImageLine(%q) = true, want false", tc.line)
			}
		})
	}
}

// -----------------------------------------------------------------------------
// isImageLine — Mixed content
// -----------------------------------------------------------------------------

func TestIsImageLine_MixedContent(t *testing.T) {
	mixed := "Kitty: \x1b_Ga=T...\x1b\\\x1b_Gm=i=1;\x1b\\ iTerm2: \x1b]1337;File=inline=1:data==\x07"
	if !IsImageLine(mixed) {
		t.Fatalf("mixed kitty+iterm2: want true")
	}
	complexLine := "Start \x1b]1337;File=img1==\x07 middle \x1b]1337;File=img2==\x07 end"
	if !IsImageLine(complexLine) {
		t.Fatalf("multiple segments: want true")
	}
}

// -----------------------------------------------------------------------------
// detectCapabilities
// -----------------------------------------------------------------------------

func TestDetectCapabilities(t *testing.T) {
	// tmuxForwards is the injected client-forwards-hyperlinks probe (default
	// probe is a live tmux call; tests inject a constant like the TS suite).
	forwardsTrue := func() bool { return true }
	forwardsFalse := func() bool { return false }

	t.Run("defaults for unknown terminals", func(t *testing.T) {
		withEnv(t, map[string]string{}, func() {
			caps := DetectCapabilities(nil)
			if caps.Hyperlinks {
				t.Fatalf("hyperlinks=true, want false")
			}
			if caps.Images != ProtocolNone {
				t.Fatalf("images=%v, want none", caps.Images)
			}
		})
	})

	t.Run("tmux forwards hyperlinks", func(t *testing.T) {
		withEnv(t, map[string]string{"TMUX": "/tmp/tmux-1000/default,1234,0", "TERM_PROGRAM": "ghostty"}, func() {
			caps := DetectCapabilities(forwardsTrue)
			if !caps.Hyperlinks {
				t.Fatalf("hyperlinks=false, want true")
			}
			if caps.Images != ProtocolNone {
				t.Fatalf("images not none under tmux")
			}
		})
	})

	t.Run("tmux does not forward hyperlinks", func(t *testing.T) {
		withEnv(t, map[string]string{"TMUX": "/tmp/tmux-1000/default,1234,0", "TERM_PROGRAM": "ghostty"}, func() {
			caps := DetectCapabilities(forwardsFalse)
			if caps.Hyperlinks {
				t.Fatalf("hyperlinks=true, want false")
			}
		})
	})

	t.Run("TERM starts with tmux", func(t *testing.T) {
		withEnv(t, map[string]string{"TERM": "tmux-256color", "TERM_PROGRAM": "iterm.app"}, func() {
			caps := DetectCapabilities(forwardsTrue)
			if !caps.Hyperlinks || caps.Images != ProtocolNone {
				t.Fatalf("term=tmux forwardsTrue: got %+v", caps)
			}
			caps2 := DetectCapabilities(forwardsFalse)
			if caps2.Hyperlinks {
				t.Fatalf("term=tmux forwardsFalse: hyperlinks true")
			}
		})
	})

	t.Run("TERM starts with screen forces hyperlinks off", func(t *testing.T) {
		withEnv(t, map[string]string{"TERM": "screen-256color"}, func() {
			caps := DetectCapabilities(nil)
			if caps.Hyperlinks || caps.Images != ProtocolNone {
				t.Fatalf("screen: got %+v", caps)
			}
		})
	})

	t.Run("ghostty enables hyperlinks", func(t *testing.T) {
		withEnv(t, map[string]string{"TERM_PROGRAM": "ghostty"}, func() {
			if !DetectCapabilities(nil).Hyperlinks {
				t.Fatalf("ghostty hyperlinks false")
			}
		})
	})

	t.Run("ghostty images not disabled by cmux", func(t *testing.T) {
		withEnv(t, map[string]string{"TERM_PROGRAM": "ghostty", "CMUX_WORKSPACE_ID": "workspace"}, func() {
			caps := DetectCapabilities(nil)
			if caps.Images != ProtocolKitty || !caps.Hyperlinks {
				t.Fatalf("ghostty+cmux: got %+v", caps)
			}
		})
	})

	t.Run("kitty enables hyperlinks", func(t *testing.T) {
		withEnv(t, map[string]string{"KITTY_WINDOW_ID": "1"}, func() {
			if !DetectCapabilities(nil).Hyperlinks {
				t.Fatalf("kitty hyperlinks false")
			}
		})
	})

	t.Run("wezterm enables hyperlinks", func(t *testing.T) {
		withEnv(t, map[string]string{"WEZTERM_PANE": "0"}, func() {
			if !DetectCapabilities(nil).Hyperlinks {
				t.Fatalf("wezterm hyperlinks false")
			}
		})
	})

	t.Run("warp via TERM_PROGRAM", func(t *testing.T) {
		withEnv(t, map[string]string{"TERM_PROGRAM": "WarpTerminal"}, func() {
			caps := DetectCapabilities(nil)
			if caps.Images != ProtocolKitty || !caps.TrueColor || !caps.Hyperlinks {
				t.Fatalf("warp: got %+v", caps)
			}
		})
	})

	t.Run("warp via WARP_SESSION_ID", func(t *testing.T) {
		withEnv(t, map[string]string{"WARP_SESSION_ID": "some-session-id"}, func() {
			caps := DetectCapabilities(nil)
			if caps.Images != ProtocolKitty || !caps.TrueColor || !caps.Hyperlinks {
				t.Fatalf("warp id: got %+v", caps)
			}
		})
	})

	t.Run("warp via WARP_TERMINAL_SESSION_UUID", func(t *testing.T) {
		withEnv(t, map[string]string{"WARP_TERMINAL_SESSION_UUID": "d0e1a2e5-7ca7-44cd-9037-ac7222011161"}, func() {
			caps := DetectCapabilities(nil)
			if caps.Images != ProtocolKitty || !caps.TrueColor || !caps.Hyperlinks {
				t.Fatalf("warp uuid: got %+v", caps)
			}
		})
	})

	t.Run("warp inside tmux disables images", func(t *testing.T) {
		withEnv(t, map[string]string{
			"TERM_PROGRAM": "WarpTerminal",
			"TMUX":         "/tmp/tmux-1000/default,1234,0",
			"TERM":         "tmux-256color",
		}, func() {
			caps := DetectCapabilities(forwardsTrue)
			if caps.Images != ProtocolNone || !caps.Hyperlinks {
				t.Fatalf("warp+tmux: got %+v", caps)
			}
		})
	})

	t.Run("iterm2 enables hyperlinks", func(t *testing.T) {
		withEnv(t, map[string]string{"TERM_PROGRAM": "iterm.app"}, func() {
			if !DetectCapabilities(nil).Hyperlinks {
				t.Fatalf("iterm2 hyperlinks false")
			}
		})
	})

	t.Run("vscode enables hyperlinks", func(t *testing.T) {
		withEnv(t, map[string]string{"TERM_PROGRAM": "vscode"}, func() {
			if !DetectCapabilities(nil).Hyperlinks {
				t.Fatalf("vscode hyperlinks false")
			}
		})
	})

	t.Run("windows terminal outside multiplexers", func(t *testing.T) {
		withEnv(t, map[string]string{"WT_SESSION": "session", "TERM": "xterm-256color"}, func() {
			caps := DetectCapabilities(nil)
			if !caps.TrueColor || !caps.Hyperlinks || caps.Images != ProtocolNone {
				t.Fatalf("wt: got %+v", caps)
			}
		})
	})

	t.Run("jetbrains truecolor no hyperlinks", func(t *testing.T) {
		withEnv(t, map[string]string{"TERMINAL_EMULATOR": "JetBrains-JediTerm", "TERM": "xterm-256color"}, func() {
			caps := DetectCapabilities(nil)
			if !caps.TrueColor || caps.Hyperlinks || caps.Images != ProtocolNone {
				t.Fatalf("jetbrains: got %+v", caps)
			}
		})
	})

	t.Run("no windows-terminal truecolor through tmux", func(t *testing.T) {
		withEnv(t, map[string]string{"WT_SESSION": "session", "TMUX": "/tmp/tmux-1000/default,1234,0", "TERM": "tmux-256color"}, func() {
			caps := DetectCapabilities(forwardsFalse)
			if caps.TrueColor || caps.Hyperlinks || caps.Images != ProtocolNone {
				t.Fatalf("wt+tmux: got %+v", caps)
			}
		})
	})

	t.Run("explicit truecolor hint through tmux", func(t *testing.T) {
		withEnv(t, map[string]string{"COLORTERM": "truecolor", "TMUX": "/tmp/tmux-1000/default,1234,0", "TERM": "tmux-256color"}, func() {
			caps := DetectCapabilities(forwardsFalse)
			if !caps.TrueColor || caps.Hyperlinks || caps.Images != ProtocolNone {
				t.Fatalf("colorterm+tmux: got %+v", caps)
			}
		})
	})
}

// -----------------------------------------------------------------------------
// Kitty image cursor movement
// -----------------------------------------------------------------------------

func TestEncodeKitty_NoCursorMovement(t *testing.T) {
	seq := EncodeKitty("AAAA", KittyOptions{Columns: 2, Rows: 2, MoveCursor: boolPtr(false)})
	if !strings.HasPrefix(seq, "\x1b_Ga=T,f=100,q=2,C=1,c=2,r=2;") {
		t.Fatalf("encodeKitty prefix mismatch: %q", seq)
	}
}

func TestDeleteKitty_SuppressesReplies(t *testing.T) {
	if got := DeleteKittyImage(42); got != "\x1b_Ga=d,d=I,i=42,q=2\x1b\\" {
		t.Fatalf("deleteKittyImage = %q", got)
	}
	if got := DeleteAllKittyImages(); got != "\x1b_Ga=d,d=A,q=2\x1b\\" {
		t.Fatalf("deleteAllKittyImages = %q", got)
	}
}

func TestRenderImage_DefaultCursorMovement(t *testing.T) {
	restore := swapCapsAndCells(Capabilities{Images: ProtocolKitty, TrueColor: true, Hyperlinks: true}, CellDimensions{WidthPx: 10, HeightPx: 10})
	defer restore()
	res := RenderImage("AAAA", ImageDimensions{WidthPx: 20, HeightPx: 20}, RenderOptions{MaxWidthCells: 2})
	if res == nil {
		t.Fatalf("renderImage nil")
	}
	if strings.Contains(res.Sequence, ",C=1,") {
		t.Fatalf("default should move cursor (no C=1): %q", res.Sequence)
	}
	if res.Rows != 2 {
		t.Fatalf("rows=%d want 2", res.Rows)
	}
}

func TestRenderImage_NoCursorMovement(t *testing.T) {
	restore := swapCapsAndCells(Capabilities{Images: ProtocolKitty, TrueColor: true, Hyperlinks: true}, CellDimensions{WidthPx: 10, HeightPx: 10})
	defer restore()
	res := RenderImage("AAAA", ImageDimensions{WidthPx: 20, HeightPx: 20}, RenderOptions{MaxWidthCells: 2, MoveCursor: boolPtr(false)})
	if res == nil {
		t.Fatalf("renderImage nil")
	}
	if !strings.Contains(res.Sequence, ",C=1,") {
		t.Fatalf("moveCursor=false should include C=1: %q", res.Sequence)
	}
	if res.Rows != 2 {
		t.Fatalf("rows=%d want 2", res.Rows)
	}
}

func TestRenderImage_MaxHeightReducesWidth(t *testing.T) {
	restore := swapCapsAndCells(Capabilities{Images: ProtocolKitty, TrueColor: true, Hyperlinks: true}, CellDimensions{WidthPx: 10, HeightPx: 10})
	defer restore()
	res := RenderImage("AAAA", ImageDimensions{WidthPx: 10, HeightPx: 100}, RenderOptions{MaxWidthCells: 10, MaxHeightCells: intPtr(5)})
	if res == nil {
		t.Fatalf("renderImage nil")
	}
	if res.Rows != 5 {
		t.Fatalf("rows=%d want 5", res.Rows)
	}
	if !strings.Contains(res.Sequence, ",c=1,r=5") {
		t.Fatalf("expected c=1,r=5: %q", res.Sequence)
	}
}

// -----------------------------------------------------------------------------
// hyperlink
// -----------------------------------------------------------------------------

func TestHyperlink(t *testing.T) {
	if got := Hyperlink("click me", "https://example.com"); got != "\x1b]8;;https://example.com\x1b\\click me\x1b]8;;\x1b\\" {
		t.Fatalf("hyperlink = %q", got)
	}
	styled := "\x1b[4m\x1b[34mclick me\x1b[0m"
	res := Hyperlink(styled, "https://example.com")
	if !strings.HasPrefix(res, "\x1b]8;;https://example.com\x1b\\") || !strings.Contains(res, styled) || !strings.HasSuffix(res, "\x1b]8;;\x1b\\") {
		t.Fatalf("styled hyperlink = %q", res)
	}
	if got := Hyperlink("", "https://example.com"); got != "\x1b]8;;https://example.com\x1b\\\x1b]8;;\x1b\\" {
		t.Fatalf("empty hyperlink = %q", got)
	}
	if got := Hyperlink("README.md", "file:///home/user/README.md"); !strings.Contains(got, "file:///home/user/README.md") || !strings.Contains(got, "README.md") {
		t.Fatalf("file uri = %q", got)
	}
}

// -----------------------------------------------------------------------------
// Placeholder fallback (neo-specific: unsupported terminal renders a placeholder)
// -----------------------------------------------------------------------------

func TestImageFallback_Placeholder(t *testing.T) {
	got := ImageFallback("image/png", &ImageDimensions{WidthPx: 800, HeightPx: 600}, "shot.png")
	want := "[Image: shot.png [image/png] 800x600]"
	if got != want {
		t.Fatalf("fallback = %q want %q", got, want)
	}
	got2 := ImageFallback("image/jpeg", nil, "")
	if got2 != "[Image: [image/jpeg]]" {
		t.Fatalf("fallback minimal = %q", got2)
	}
}

func TestRenderImage_NoImageSupportReturnsNil(t *testing.T) {
	restore := swapCapsAndCells(Capabilities{Images: ProtocolNone, TrueColor: false, Hyperlinks: false}, CellDimensions{WidthPx: 9, HeightPx: 18})
	defer restore()
	if RenderImage("AAAA", ImageDimensions{WidthPx: 20, HeightPx: 20}, RenderOptions{MaxWidthCells: 2}) != nil {
		t.Fatalf("renderImage should be nil when images unsupported")
	}
}
