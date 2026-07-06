package main

import (
	"bytes"
	"strings"
	"testing"
)

// TestVersionBanner asserts the banner composition so a link-time -X override
// of version is reflected while the module path stays fixed.
func TestVersionBanner(t *testing.T) {
	orig := version
	t.Cleanup(func() { version = orig })

	version = "dev"
	if got, want := versionBanner(), "senpi-neo dev ("+modulePath+")"; got != want {
		t.Fatalf("versionBanner() = %q, want %q", got, want)
	}

	version = "v1.2.3"
	if got, want := versionBanner(), "senpi-neo v1.2.3 ("+modulePath+")"; got != want {
		t.Fatalf("versionBanner() with stamp = %q, want %q", got, want)
	}
}

// TestRunVersionFlag asserts `--version` prints exactly the banner and exits 0.
func TestRunVersionFlag(t *testing.T) {
	orig := version
	t.Cleanup(func() { version = orig })
	version = "dev"

	var out bytes.Buffer
	code := run([]string{"--version"}, &out)
	if code != 0 {
		t.Fatalf("run(--version) exit = %d, want 0", code)
	}
	got := strings.TrimRight(out.String(), "\n")
	if want := versionBanner(); got != want {
		t.Fatalf("run(--version) stdout = %q, want %q", got, want)
	}
	if strings.Contains(got, "not yet implemented") {
		t.Fatalf("run(--version) should print only the banner, got %q", got)
	}
}

// TestModulePathPinned guards the exact module path the plan pins, since every
// import in the module depends on it.
func TestModulePathPinned(t *testing.T) {
	if want := "github.com/code-yeongyu/senpi/packages/neo"; modulePath != want {
		t.Fatalf("modulePath = %q, want %q", modulePath, want)
	}
}

// TestThemeSampleTruecolorEmitsSGR asserts the hidden --theme-sample flag renders
// the grok panel with truecolor SGR (the default neo path) and exits 0.
func TestThemeSampleTruecolorEmitsSGR(t *testing.T) {
	var out bytes.Buffer
	code := run([]string{"--theme-sample"}, &out)
	if code != 0 {
		t.Fatalf("run(--theme-sample) exit = %d, want 0", code)
	}
	s := out.String()
	// The base surface hex #141414 must appear as a truecolor bg SGR.
	if !strings.Contains(s, "48;2;20;20;20") {
		t.Fatalf("truecolor sample missing base surface SGR; got:\n%q", s)
	}
	// The green accent #9ece6a must appear as a truecolor fg SGR.
	if !strings.Contains(s, "38;2;158;206;106") {
		t.Fatalf("truecolor sample missing green accent SGR; got:\n%q", s)
	}
}

// TestThemeSampleAnsi256EmitsNoTruecolor asserts the 256-color fallback: the
// panel renders without any `38;2`/`48;2` truecolor SGR and exits 0 (no crash).
func TestThemeSampleAnsi256EmitsNoTruecolor(t *testing.T) {
	var out bytes.Buffer
	code := run([]string{"--theme-sample", "ansi256"}, &out)
	if code != 0 {
		t.Fatalf("run(--theme-sample ansi256) exit = %d, want 0", code)
	}
	s := out.String()
	if strings.Contains(s, "38;2;") || strings.Contains(s, "48;2;") {
		t.Fatalf("ansi256 sample unexpectedly emitted truecolor SGR:\n%q", s)
	}
	// It still must carry SOME 256-color SGR (5;<idx>) — proving color survives.
	if !strings.Contains(s, "38;5;") {
		t.Fatalf("ansi256 sample missing 256-color fg SGR:\n%q", s)
	}
}

// TestThemeSampleNoColorStripsColor asserts the NO_COLOR path: rendering at the
// ascii profile emits no color SGR at all, but preserves the panel text.
func TestThemeSampleNoColorStripsColor(t *testing.T) {
	var out bytes.Buffer
	code := run([]string{"--theme-sample", "ascii"}, &out)
	if code != 0 {
		t.Fatalf("run(--theme-sample ascii) exit = %d, want 0", code)
	}
	s := out.String()
	if strings.Contains(s, "\x1b[38") || strings.Contains(s, "\x1b[48") {
		t.Fatalf("ascii sample unexpectedly emitted color SGR:\n%q", s)
	}
	if !strings.Contains(s, "Composer 2.5") {
		t.Fatalf("ascii sample dropped panel text; got:\n%q", s)
	}
}

// TestThemeSampleUnknownProfile reports an error and exits non-zero.
func TestThemeSampleUnknownProfile(t *testing.T) {
	var out bytes.Buffer
	code := run([]string{"--theme-sample", "banana"}, &out)
	if code != 2 {
		t.Fatalf("run(--theme-sample banana) exit = %d, want 2", code)
	}
}
