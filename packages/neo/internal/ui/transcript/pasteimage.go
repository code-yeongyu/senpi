package transcript

import (
	"encoding/base64"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store/clipboard"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/transcript/terminalimage"
)

// RenderPastedImage renders an image pasted from the clipboard (plan task 9's
// "paste-image path (task-6 adapter)"). It is the neo counterpart of the TS
// flow: the task-6 clipboard adapter (internal/store/clipboard) yields
// ImageData{Bytes, MimeType}; here the dimensions are decoded and the image is
// emitted either as the terminal's inline-image protocol escape (kitty/iterm2,
// when the terminal is image-capable) or as the text placeholder otherwise.
//
// Mirrors packages/tui/src/terminal-image.ts getImageDimensions →
// renderImage / imageFallback, driven by
// packages/coding-agent/src/utils/clipboard-image.ts readClipboardImage.
func RenderPastedImage(img clipboard.ImageData, opts terminalimage.RenderOptions) string {
	dims := terminalimage.GetImageDimensions(img.Bytes, img.MimeType)

	// Image-capable terminal + decodable dimensions → protocol escape.
	if dims != nil {
		b64 := base64.StdEncoding.EncodeToString(img.Bytes)
		if res := terminalimage.RenderImage(b64, *dims, opts); res != nil {
			return res.Sequence
		}
	}

	// Otherwise fall back to the text placeholder (incapable terminal, or an
	// undecodable paste). Dimensions are omitted when unknown so no bogus 0x0 is
	// shown.
	return terminalimage.ImageFallback(img.MimeType, dims, "")
}
