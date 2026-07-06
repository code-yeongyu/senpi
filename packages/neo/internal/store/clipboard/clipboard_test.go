package clipboard

import (
	"bytes"
	"errors"
	"testing"
)

// clipboard_test.go drives the per-OS shell-out matrix through a fake runner so
// no real clipboard tool is touched. Written RED first against the stub Adapter.
//
// The fake records which command was invoked (name + args) and returns scripted
// output, letting each test assert the adapter picked the right tool for the OS
// and clipboard tool availability.

type fakeRunner struct {
	// present is the set of tool names LookPath should resolve.
	present map[string]bool
	// outputs maps a command name to the stdout it should return.
	outputs map[string][]byte
	// errs maps a command name to an error it should return.
	errs map[string]error
	// calls records every run/runStdin invocation as "name arg1 arg2".
	calls []string
	// stdinCalls records the input bytes passed to runStdin, keyed by name.
	stdin map[string][]byte
}

func newFake() *fakeRunner {
	return &fakeRunner{
		present: map[string]bool{},
		outputs: map[string][]byte{},
		errs:    map[string]error{},
		stdin:   map[string][]byte{},
	}
}

func (f *fakeRunner) lookPath(name string) (string, error) {
	if f.present[name] {
		return "/usr/bin/" + name, nil
	}
	return "", errors.New("not found")
}

func (f *fakeRunner) run(name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, name)
	if err := f.errs[name]; err != nil {
		return nil, err
	}
	return f.outputs[name], nil
}

func (f *fakeRunner) runStdin(input []byte, name string, args ...string) error {
	f.calls = append(f.calls, name)
	f.stdin[name] = append([]byte(nil), input...)
	return f.errs[name]
}

// newAdapter builds an Adapter for a given OS backed by the fake runner. This
// helper is what the implementation must expose (unexported constructor) so the
// tests can inject both.
func newAdapter(goos string, r runner) *Adapter {
	return newAdapterForTest(goos, r)
}

func called(f *fakeRunner, name string) bool {
	for _, c := range f.calls {
		if c == name {
			return true
		}
	}
	return false
}

// ---- macOS ----

func TestMacOS_ReadText_pbpaste(t *testing.T) {
	f := newFake()
	f.present["pbpaste"] = true
	f.present["pbcopy"] = true
	f.outputs["pbpaste"] = []byte("hello mac")
	a := newAdapter("darwin", f)

	if !a.Available() {
		t.Fatalf("Available() = false, want true when pbpaste present")
	}
	got, err := a.ReadText()
	if err != nil {
		t.Fatalf("ReadText err = %v", err)
	}
	if got != "hello mac" {
		t.Errorf("ReadText = %q, want %q", got, "hello mac")
	}
	if !called(f, "pbpaste") {
		t.Errorf("expected pbpaste to be invoked, calls=%v", f.calls)
	}
}

func TestMacOS_WriteText_pbcopy(t *testing.T) {
	f := newFake()
	f.present["pbcopy"] = true
	a := newAdapter("darwin", f)
	if err := a.WriteText("copy me"); err != nil {
		t.Fatalf("WriteText err = %v", err)
	}
	if !bytes.Equal(f.stdin["pbcopy"], []byte("copy me")) {
		t.Errorf("pbcopy stdin = %q, want %q", f.stdin["pbcopy"], "copy me")
	}
}

func TestMacOS_ReadImage_osascript(t *testing.T) {
	f := newFake()
	f.present["osascript"] = true
	// osascript path returns raw PNG bytes via the adapter's temp-file dance;
	// we model that by having the adapter's osascript call yield PNG bytes.
	png := []byte("\x89PNG\r\n\x1a\nDATA")
	f.outputs["osascript"] = png
	a := newAdapter("darwin", f)
	img, err := a.ReadImage()
	if err != nil {
		t.Fatalf("ReadImage err = %v", err)
	}
	if img.MimeType != "image/png" {
		t.Errorf("MimeType = %q, want image/png", img.MimeType)
	}
	if !bytes.Equal(img.Bytes, png) {
		t.Errorf("image bytes mismatch")
	}
}

// ---- Linux (Wayland preferred, then X11) ----

func TestLinux_PrefersWaylandWlPaste(t *testing.T) {
	f := newFake()
	f.present["wl-paste"] = true
	f.present["xclip"] = true // both present: Wayland must win
	f.outputs["wl-paste"] = []byte("wayland text")
	a := newAdapter("linux", f)
	got, err := a.ReadText()
	if err != nil {
		t.Fatalf("ReadText err = %v", err)
	}
	if got != "wayland text" {
		t.Errorf("ReadText = %q, want wayland text", got)
	}
	if !called(f, "wl-paste") || called(f, "xclip") {
		t.Errorf("expected wl-paste (not xclip), calls=%v", f.calls)
	}
}

func TestLinux_FallsBackToXclip(t *testing.T) {
	f := newFake()
	f.present["xclip"] = true
	f.outputs["xclip"] = []byte("x11 text")
	a := newAdapter("linux", f)
	got, err := a.ReadText()
	if err != nil {
		t.Fatalf("ReadText err = %v", err)
	}
	if got != "x11 text" {
		t.Errorf("ReadText = %q, want x11 text", got)
	}
}

func TestLinux_FallsBackToXsel(t *testing.T) {
	f := newFake()
	f.present["xsel"] = true
	f.outputs["xsel"] = []byte("xsel text")
	a := newAdapter("linux", f)
	got, err := a.ReadText()
	if err != nil {
		t.Fatalf("ReadText err = %v", err)
	}
	if got != "xsel text" {
		t.Errorf("ReadText = %q, want xsel text", got)
	}
}

func TestLinux_ReadImage_wlPastePNG(t *testing.T) {
	f := newFake()
	f.present["wl-paste"] = true
	png := []byte("\x89PNG\r\n\x1a\nLINUXIMG")
	f.outputs["wl-paste"] = png
	a := newAdapter("linux", f)
	img, err := a.ReadImage()
	if err != nil {
		t.Fatalf("ReadImage err = %v", err)
	}
	if img.MimeType != "image/png" || !bytes.Equal(img.Bytes, png) {
		t.Errorf("image mismatch: mime=%q len=%d", img.MimeType, len(img.Bytes))
	}
}

// ---- Windows ----

func TestWindows_ReadText_Powershell(t *testing.T) {
	f := newFake()
	f.present["powershell"] = true
	f.present["powershell.exe"] = true
	f.outputs["powershell"] = []byte("win text\r\n")
	f.outputs["powershell.exe"] = []byte("win text\r\n")
	a := newAdapter("windows", f)
	got, err := a.ReadText()
	if err != nil {
		t.Fatalf("ReadText err = %v", err)
	}
	// Trailing CRLF that Get-Clipboard appends must be trimmed.
	if got != "win text" {
		t.Errorf("ReadText = %q, want %q", got, "win text")
	}
}

func TestWindows_WriteText_ClipExe(t *testing.T) {
	f := newFake()
	f.present["clip"] = true
	f.present["clip.exe"] = true
	a := newAdapter("windows", f)
	if err := a.WriteText("hi win"); err != nil {
		t.Fatalf("WriteText err = %v", err)
	}
	if !bytes.Equal(f.stdin["clip"], []byte("hi win")) && !bytes.Equal(f.stdin["clip.exe"], []byte("hi win")) {
		t.Errorf("clip stdin not set correctly: %q / %q", f.stdin["clip"], f.stdin["clip.exe"])
	}
}

// ---- Unavailable everywhere ----

func TestUnavailable_NoToolsPresent(t *testing.T) {
	for _, goos := range []string{"darwin", "linux", "windows"} {
		f := newFake() // nothing present
		a := newAdapter(goos, f)
		if a.Available() {
			t.Errorf("[%s] Available() = true, want false with no tools", goos)
		}
		if _, err := a.ReadText(); !errors.Is(err, ErrUnavailable) {
			t.Errorf("[%s] ReadText err = %v, want ErrUnavailable", goos, err)
		}
		if err := a.WriteText("x"); !errors.Is(err, ErrUnavailable) {
			t.Errorf("[%s] WriteText err = %v, want ErrUnavailable", goos, err)
		}
		if _, err := a.ReadImage(); !errors.Is(err, ErrUnavailable) {
			t.Errorf("[%s] ReadImage err = %v, want ErrUnavailable", goos, err)
		}
	}
}

// ReadImage with no image on the clipboard (tool present but returns empty) must
// surface ErrUnavailable, not an empty image, so the UI notice path fires.
func TestReadImage_EmptyClipboard(t *testing.T) {
	f := newFake()
	f.present["wl-paste"] = true
	f.outputs["wl-paste"] = nil // empty
	a := newAdapter("linux", f)
	if _, err := a.ReadImage(); !errors.Is(err, ErrUnavailable) {
		t.Errorf("ReadImage on empty clipboard err = %v, want ErrUnavailable", err)
	}
}
