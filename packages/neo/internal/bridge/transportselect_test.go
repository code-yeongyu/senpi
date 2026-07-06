package bridge

import (
	"testing"
)

// The transport selector decides, from the neo launcher argv and the per-platform
// default gate, whether this instance uses the shared daemon or an isolated stdio
// backend. --isolated always forces isolated; otherwise the platform default
// (windowsDefaultsToIsolated, a code switch task 20 flips) decides.

func TestSelectTransportMode_IsolatedFlagForcesIsolated(t *testing.T) {
	mode := SelectTransportMode([]string{"--isolated", "--model", "m"}, "linux")
	if mode != TransportIsolated {
		t.Fatalf("--isolated must force isolated, got %v", mode)
	}
}

func TestSelectTransportMode_DefaultIsDaemonOnPosix(t *testing.T) {
	for _, goos := range []string{"linux", "darwin"} {
		if mode := SelectTransportMode([]string{"--model", "m"}, goos); mode != TransportDaemon {
			t.Fatalf("%s default should be daemon, got %v", goos, mode)
		}
	}
}

func TestSelectTransportMode_WindowsDefaultGate(t *testing.T) {
	// The Windows default is governed by windowsDefaultsToIsolated, an
	// implementation switch task 20 flips if the Windows attach scenario is red.
	// This test pins the CURRENT default and the switch's effect via the
	// overridable selector so task 20 can flip one constant.
	mode := selectTransportModeWith([]string{"--model", "m"}, "windows", false /*windowsIsolated*/)
	if mode != TransportDaemon {
		t.Fatalf("with the gate open, windows default should be daemon, got %v", mode)
	}
	gated := selectTransportModeWith([]string{"--model", "m"}, "windows", true /*windowsIsolated*/)
	if gated != TransportIsolated {
		t.Fatalf("with the gate set, windows default should be isolated, got %v", gated)
	}
}

func TestSelectTransportMode_IsolatedFlagBeatsGate(t *testing.T) {
	// --isolated is honored on every platform regardless of the gate.
	if m := selectTransportModeWith([]string{"--isolated"}, "windows", false); m != TransportIsolated {
		t.Fatalf("--isolated must win on windows too, got %v", m)
	}
}
