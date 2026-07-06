package terminalimage

// Test-only helpers used by terminalimage_test.go. These are pure support
// utilities (env manipulation, pointer literals, capability swapping) — the
// production functions under test (IsImageLine, DetectCapabilities, EncodeKitty,
// RenderImage, Hyperlink, ImageFallback, DeleteKittyImage, DeleteAllKittyImages)
// live in the non-test package files and are what the RED phase is missing.

import "os"

func setEnv(k, v string) {
	if v == "" {
		_ = os.Unsetenv(k)
		return
	}
	_ = os.Setenv(k, v)
}

func unsetAll(keys []string) {
	for _, k := range keys {
		_ = os.Unsetenv(k)
	}
}

func boolPtr(b bool) *bool { return &b }
func intPtr(i int) *int    { return &i }

// swapCapsAndCells overrides the cached capabilities + cell dimensions and
// returns a restore func. Mirrors setCapabilities/setCellDimensions +
// resetCapabilitiesCache teardown in the TS suite.
func swapCapsAndCells(caps Capabilities, cells CellDimensions) func() {
	SetCapabilities(caps)
	SetCellDimensions(cells)
	return func() {
		ResetCapabilitiesCache()
		SetCellDimensions(CellDimensions{WidthPx: 9, HeightPx: 18})
	}
}
