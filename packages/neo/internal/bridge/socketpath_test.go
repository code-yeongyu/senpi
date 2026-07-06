package bridge

import (
	"runtime"
	"strings"
	"testing"
)

// TestChooseSocketPathDeterministic proves the spawned socket path is a pure
// function of the resolved cwd: stable across calls, equal for the same cwd,
// different for different cwds. This is what makes the "bind is the mutex"
// protocol engage — every concurrent racer in one cwd must pass the SAME
// --listen path so exactly one daemon wins bind().
func TestChooseSocketPathDeterministic(t *testing.T) {
	const cwd = "/proj/deterministic"

	first, err := chooseSocketPath(cwd)
	if err != nil {
		t.Fatalf("chooseSocketPath: %v", err)
	}
	// Repeated calls (and, by extension, separate client processes) must agree.
	for i := 0; i < 8; i++ {
		again, err := chooseSocketPath(cwd)
		if err != nil {
			t.Fatalf("chooseSocketPath repeat %d: %v", i, err)
		}
		if again != first {
			t.Fatalf("chooseSocketPath is not deterministic: %q != %q", again, first)
		}
	}

	// A different cwd must map to a different socket path (collision-resistant).
	other, err := chooseSocketPath("/proj/other")
	if err != nil {
		t.Fatalf("chooseSocketPath other: %v", err)
	}
	if other == first {
		t.Fatalf("distinct cwds must map to distinct socket paths, both got %q", first)
	}
}

// TestChooseSocketPathFitsSunPath keeps the derived path within the unix
// sun_path limit (~104 bytes on macOS, 108 on Linux). A deterministic name
// derived from a fixed-length hash under os.TempDir() must always fit even for
// an arbitrarily deep cwd.
func TestChooseSocketPathFitsSunPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sun_path limit does not apply to Windows named pipes")
	}
	// An absurdly deep cwd must not bloat the socket path — the hash is fixed-length.
	deepCwd := "/" + strings.Repeat("a-very-deep-directory-segment/", 40)
	path, err := chooseSocketPath(deepCwd)
	if err != nil {
		t.Fatalf("chooseSocketPath deep: %v", err)
	}
	const sunPathMax = 104 // macOS is the tightest of the platforms we ship.
	if len(path) >= sunPathMax {
		t.Fatalf("socket path %q (%d bytes) does not fit sun_path (%d)", path, len(path), sunPathMax)
	}
}
