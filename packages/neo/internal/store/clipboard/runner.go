package clipboard

import (
	"bytes"
	"os"
	"os/exec"
)

// runner abstracts command execution so tests can simulate tool presence,
// output, and failures without touching a real clipboard. lookPath mirrors
// exec.LookPath; run captures stdout; runStdin feeds input to a command.
type runner interface {
	lookPath(name string) (string, error)
	run(name string, args ...string) ([]byte, error)
	runStdin(input []byte, name string, args ...string) error
}

// execRunner is the production runner backed by os/exec.
type execRunner struct{}

func (execRunner) lookPath(name string) (string, error) { return exec.LookPath(name) }

func (execRunner) run(name string, args ...string) ([]byte, error) {
	// macOS clipboard image reads go through osascript, which cannot stream
	// binary to stdout: the AppleScript writes the PNG to a temp file whose path
	// is passed via SENPI_NEO_CLIP_PNG, then we read that file back. Detect that
	// specific invocation and perform the dance transparently so callers get the
	// image bytes uniformly through run().
	if name == "osascript" && isOsascriptImageArgs(args) {
		return runOsascriptImage(args)
	}

	cmd := exec.Command(name, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func (execRunner) runStdin(input []byte, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdin = bytes.NewReader(input)
	return cmd.Run()
}

// runOsascriptImage runs the osascript image script with a temp-file target and
// returns the written PNG bytes (empty when the clipboard held no image).
func runOsascriptImage(args []string) ([]byte, error) {
	path, cleanup, err := tempPNGPath()
	if err != nil {
		return nil, err
	}
	defer cleanup()

	cmd := exec.Command("osascript", args...)
	cmd.Env = append(os.Environ(), "SENPI_NEO_CLIP_PNG="+path)
	if err := cmd.Run(); err != nil {
		// No image on the clipboard makes osascript fail; treat as empty so the
		// adapter maps it to ErrUnavailable rather than a hard error.
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil
	}
	return data, nil
}

// isOsascriptImageArgs reports whether args are the osascript image-read args.
func isOsascriptImageArgs(args []string) bool {
	return len(args) == 2 && args[0] == "-e" && args[1] == osascriptImageScript
}

// osascriptImageArgs builds the argv for reading a clipboard image on macOS.
func osascriptImageArgs() []string {
	return []string{"-e", osascriptImageScript}
}

// osascriptImageScript reads image data from the clipboard and writes it to the
// file named in the SENPI_NEO_CLIP_PNG environment variable.
const osascriptImageScript = `set thePath to (system attribute "SENPI_NEO_CLIP_PNG")
set theData to the clipboard as «class PNGf»
set theFile to open for access (POSIX file thePath) with write permission
set eof theFile to 0
write theData to theFile
close access theFile`

// powershellImageScript reads a clipboard image as PNG and writes raw bytes to
// stdout; the caller reads them directly. Kept as a single -Command string.
func powershellImageScript() string {
	return `Add-Type -AssemblyName System.Windows.Forms; ` +
		`Add-Type -AssemblyName System.Drawing; ` +
		`$img=[System.Windows.Forms.Clipboard]::GetImage(); ` +
		`if($img -ne $null){$ms=New-Object System.IO.MemoryStream; ` +
		`$img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); ` +
		`$bytes=$ms.ToArray(); [Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length)}`
}

// tempPNGPath returns a fresh temp file path for the macOS osascript dance plus a
// cleanup closure.
func tempPNGPath() (string, func(), error) {
	f, err := os.CreateTemp("", "neo-clip-*.png")
	if err != nil {
		return "", func() {}, err
	}
	path := f.Name()
	_ = f.Close()
	return path, func() { _ = os.Remove(path) }, nil
}
