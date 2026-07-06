// Package clipboard is the neo TUI's CGO-free clipboard adapter. Because the
// neo binary is built with CGO_ENABLED=0 (plan task 18), it cannot link the
// usual cgo clipboard libraries; instead it shells out to the platform's native
// clipboard tools:
//
//	macOS   - pbpaste / pbcopy for text; osascript for image read.
//	Linux   - wl-paste / wl-copy (Wayland) or xclip / xsel (X11), auto-detected.
//	Windows - Get-Clipboard (PowerShell) / clip.exe for text; PowerShell for image.
//
// When no suitable tool is present the adapter returns ErrUnavailable so the UI
// can show a graceful "clipboard unavailable" notice rather than crashing. It is
// used by app.clipboard.pasteImage (task 6) and /copy /share (task 11).
package clipboard

import (
	"errors"
	"runtime"
)

// ErrUnavailable is returned when no clipboard tool is available on the host, or
// when the clipboard holds no content of the requested kind.
var ErrUnavailable = errors.New("clipboard unavailable")

// ImageData is a decoded clipboard image: its raw bytes and a MIME type such as
// "image/png".
type ImageData struct {
	Bytes    []byte
	MimeType string
}

// Adapter resolves and drives the host clipboard tools. The zero value is not
// usable; construct one with New.
type Adapter struct {
	os  string
	run runner
}

// New returns an Adapter bound to the current GOOS and a real command runner.
func New() *Adapter {
	return &Adapter{os: runtime.GOOS, run: execRunner{}}
}

// newAdapterForTest builds an Adapter for an explicit GOOS and injected runner.
func newAdapterForTest(goos string, r runner) *Adapter {
	return &Adapter{os: goos, run: r}
}

// Available reports whether at least one clipboard tool for text is present.
func (a *Adapter) Available() bool {
	_, _, ok := a.textReadTool()
	if ok {
		return true
	}
	_, _, ok = a.textWriteTool()
	return ok
}

// ReadText returns the clipboard's text content, or ErrUnavailable when no
// text-read tool is present.
func (a *Adapter) ReadText() (string, error) {
	name, args, ok := a.textReadTool()
	if !ok {
		return "", ErrUnavailable
	}
	out, err := a.run.run(name, args...)
	if err != nil {
		return "", err
	}
	// Windows Get-Clipboard appends a trailing CRLF; trim exactly one so the
	// payload round-trips. Other tools return content verbatim.
	if a.os == "windows" {
		out = trimTrailingCRLF(out)
	}
	return string(out), nil
}

// WriteText sets the clipboard's text content, or returns ErrUnavailable.
func (a *Adapter) WriteText(s string) error {
	name, args, ok := a.textWriteTool()
	if !ok {
		return ErrUnavailable
	}
	return a.run.runStdin([]byte(s), name, args...)
}

// ReadImage returns a decoded clipboard image, or ErrUnavailable when no image
// is present or no image-capable tool exists.
func (a *Adapter) ReadImage() (ImageData, error) {
	name, args, ok := a.imageReadTool()
	if !ok {
		return ImageData{}, ErrUnavailable
	}
	out, err := a.run.run(name, args...)
	if err != nil {
		return ImageData{}, err
	}
	if len(out) == 0 {
		// Tool present but clipboard held no image: surface the notice path.
		return ImageData{}, ErrUnavailable
	}
	return ImageData{Bytes: out, MimeType: sniffImageMime(out)}, nil
}

// trimTrailingCRLF removes a single trailing \r\n or \n.
func trimTrailingCRLF(b []byte) []byte {
	if n := len(b); n >= 2 && b[n-2] == '\r' && b[n-1] == '\n' {
		return b[:n-2]
	}
	if n := len(b); n >= 1 && b[n-1] == '\n' {
		return b[:n-1]
	}
	return b
}

// sniffImageMime returns the MIME type for common image byte signatures,
// defaulting to image/png (the format osascript/wl-paste emit for screenshots).
func sniffImageMime(b []byte) string {
	switch {
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return "image/jpeg"
	case len(b) >= 6 && string(b[:6]) == "GIF89a":
		return "image/gif"
	case len(b) >= 6 && string(b[:6]) == "GIF87a":
		return "image/gif"
	default:
		return "image/png"
	}
}
