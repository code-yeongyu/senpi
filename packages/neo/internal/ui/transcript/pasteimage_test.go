package transcript

// Ported contract for the paste-image path (plan task 9, fifth image test:
// "paste-image path (task-6 adapter)"). Source flow:
// packages/coding-agent/src/utils/clipboard-image.ts readClipboardImage →
// packages/tui/src/terminal-image.ts getImageDimensions → renderImage /
// imageFallback. The neo seam is: the task-6 clipboard adapter
// (internal/store/clipboard) yields ImageData{Bytes, MimeType}; the transcript
// decodes the dimensions and either emits the terminal's inline-image protocol
// escape (when the terminal is image-capable) or the text placeholder otherwise.
//
// RED first: RenderPastedImage / terminalimage.GetImageDimensions do not exist
// until the GREEN impl lands.

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store/clipboard"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/transcript/terminalimage"
)

// pngBytes builds a minimal valid PNG header (signature + IHDR width/height) so
// GetImageDimensions can decode a real WxH the way clipboard-image.ts pastes
// (osascript/wl-paste emit PNG). Body beyond IHDR is irrelevant to dimensions.
func pngBytes(width, height int) []byte {
	b := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a} // PNG signature
	// bytes 8..15: IHDR chunk length + "IHDR"; bytes 16..23: width, height BE.
	b = append(b, 0x00, 0x00, 0x00, 0x0d) // IHDR length = 13
	b = append(b, 'I', 'H', 'D', 'R')
	b = append(b,
		byte(width>>24), byte(width>>16), byte(width>>8), byte(width),
		byte(height>>24), byte(height>>16), byte(height>>8), byte(height),
	)
	// pad to keep length >= 24 (already 24 here) — real IHDR continues with
	// bit-depth/color-type/etc., unread by the dimension sniffer.
	b = append(b, 0x08, 0x06, 0x00, 0x00, 0x00)
	return b
}

func TestRenderPastedImage_KittyEmitsProtocolEscape(t *testing.T) {
	// task-6 adapter output: a pasted PNG screenshot. Terminal supports kitty.
	terminalimage.SetCapabilities(terminalimage.Capabilities{
		Images: terminalimage.ProtocolKitty, TrueColor: true, Hyperlinks: true,
	})
	defer terminalimage.ResetCapabilitiesCache()

	raw := pngBytes(64, 32)
	img := clipboard.ImageData{Bytes: raw, MimeType: "image/png"}

	out := RenderPastedImage(img, terminalimage.RenderOptions{MaxWidthCells: 40})

	// Image-capable terminal → inline-image protocol escape, NOT a placeholder.
	if !strings.HasPrefix(out, "\x1b_G") {
		t.Fatalf("expected kitty graphics escape, got %q", out)
	}
	if strings.Contains(out, "[Image:") {
		t.Fatalf("capable terminal must not emit text placeholder: %q", out)
	}
	// The escape must carry the base64 of the pasted bytes (the adapter seam).
	wantB64 := base64.StdEncoding.EncodeToString(raw)
	if !strings.Contains(out, wantB64) {
		t.Fatalf("escape did not carry the pasted image bytes")
	}
}

func TestRenderPastedImage_UnsupportedTerminalPlaceholder(t *testing.T) {
	// Same paste, terminal cannot draw images → text placeholder fallback
	// carrying the mime type + decoded dimensions (imageFallback contract).
	terminalimage.SetCapabilities(terminalimage.Capabilities{
		Images: terminalimage.ProtocolNone, TrueColor: false, Hyperlinks: false,
	})
	defer terminalimage.ResetCapabilitiesCache()

	img := clipboard.ImageData{Bytes: pngBytes(64, 32), MimeType: "image/png"}
	out := RenderPastedImage(img, terminalimage.RenderOptions{MaxWidthCells: 40})

	if !strings.HasPrefix(out, "[Image:") {
		t.Fatalf("unsupported terminal must emit placeholder, got %q", out)
	}
	if !strings.Contains(out, "image/png") {
		t.Fatalf("placeholder missing mime type: %q", out)
	}
	if !strings.Contains(out, "64x32") {
		t.Fatalf("placeholder missing decoded dimensions: %q", out)
	}
	if strings.Contains(out, "\x1b_G") || strings.Contains(out, "\x1b]1337") {
		t.Fatalf("placeholder must not contain protocol escape bytes: %q", out)
	}
}

func TestRenderPastedImage_UndecodableDimensionsStillPlaceholder(t *testing.T) {
	// A paste whose bytes are not a decodable image (dimensions unknown) still
	// yields a graceful placeholder on an incapable terminal — never a panic and
	// never a bogus protocol escape (mirrors imageFallback with no dimensions).
	terminalimage.SetCapabilities(terminalimage.Capabilities{
		Images: terminalimage.ProtocolNone,
	})
	defer terminalimage.ResetCapabilitiesCache()

	img := clipboard.ImageData{Bytes: []byte("not-an-image"), MimeType: "image/png"}
	out := RenderPastedImage(img, terminalimage.RenderOptions{})
	if !strings.HasPrefix(out, "[Image:") {
		t.Fatalf("expected placeholder for undecodable paste, got %q", out)
	}
	if strings.Contains(out, "x") && strings.Contains(out, "0x0") {
		t.Fatalf("must not emit bogus 0x0 dimensions: %q", out)
	}
}
