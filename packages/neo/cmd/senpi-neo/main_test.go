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
