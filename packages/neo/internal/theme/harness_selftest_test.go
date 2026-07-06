package theme

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// These tests wire the xterm.js evidence harness self-tests into `go test`, so
// the neo Go test suite (and thus `npm run check:neo`) fails if the harness or
// its verify-manifest mode regresses. They shell out to the node harness and
// skip gracefully when node is absent (Go-less/node-less machines still pass).

// TestHarnessSelfTest runs `xterm-render.mjs self-test`, which renders a fixture,
// asserts a known cell hex+glyph from the grid, proves a corrupted fixture FAILS
// loudly, and runs the verify-manifest negative self-tests (missing frame /
// missing assertion / missing triplet leg all FAIL).
func TestHarnessSelfTest(t *testing.T) {
	if !nodeAvailable() {
		t.Skip("node not on PATH; harness self-test requires node + @xterm/headless")
	}
	cmd := exec.Command("node", harnessPath(t), "self-test")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("harness self-test failed (exit non-zero): %v\n%s", err, out)
	}
	if !strings.Contains(string(out), `"failed": 0`) {
		t.Fatalf("harness self-test reported failures:\n%s", out)
	}
}

// TestVerifyManifestPasses runs `xterm-render.mjs verify-manifest` against the
// committed visual-claims.json, proving task-2's own registered claims are
// satisfied: complete triplets + passing grid assertions.
func TestVerifyManifestPasses(t *testing.T) {
	if !nodeAvailable() {
		t.Skip("node not on PATH; verify-manifest requires node + @xterm/headless")
	}
	manifest := filepath.Join(filepath.Dir(harnessPath(t)), "visual-claims.json")
	cmd := exec.Command("node", harnessPath(t), "verify-manifest", manifest)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("verify-manifest failed (task-2 claims not satisfied): %v\n%s", err, out)
	}
	if !strings.Contains(string(out), `"ok": true`) {
		t.Fatalf("verify-manifest did not report ok:true:\n%s", out)
	}
}
