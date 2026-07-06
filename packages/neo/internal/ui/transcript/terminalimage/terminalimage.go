// Package terminalimage ports packages/tui/src/terminal-image.ts: terminal
// capability detection (kitty/iterm2/none image protocols, truecolor,
// hyperlinks), kitty/iterm2 escape encoding, image cell-size math, and the
// unsupported-terminal placeholder fallback. It is the single seam neo uses to
// decide whether an inline image can be drawn and, if so, to emit the protocol
// bytes; otherwise the transcript renders a text placeholder.
//
// The contract is locked by terminalimage_test.go, a faithful port of
// packages/tui/test/terminal-image.test.ts (see the source→Go mapping table in
// .omo/evidence/task-9-neo-go-tui.md).
package terminalimage

import (
	"os"
	"os/exec"
	"strings"
	"time"
)

// Protocol is the inline-image protocol a terminal supports.
type Protocol int

const (
	// ProtocolNone means no inline image protocol is available.
	ProtocolNone Protocol = iota
	// ProtocolKitty is the kitty graphics protocol (APC _G).
	ProtocolKitty
	// ProtocolITerm2 is the iTerm2 inline-image protocol (OSC 1337).
	ProtocolITerm2
)

func (p Protocol) String() string {
	switch p {
	case ProtocolKitty:
		return "kitty"
	case ProtocolITerm2:
		return "iterm2"
	default:
		return "none"
	}
}

// Capabilities describes the detected terminal features.
type Capabilities struct {
	Images     Protocol
	TrueColor  bool
	Hyperlinks bool
}

// CellDimensions is the terminal cell size in pixels (queried by the TUI; a
// sane default is used until the terminal responds).
type CellDimensions struct {
	WidthPx  int
	HeightPx int
}

// ImageDimensions is a decoded raster image size in pixels.
type ImageDimensions struct {
	WidthPx  int
	HeightPx int
}

var (
	cachedCaps     *Capabilities
	cellDimensions = CellDimensions{WidthPx: 9, HeightPx: 18}
)

// GetCellDimensions returns the current cell dimensions.
func GetCellDimensions() CellDimensions { return cellDimensions }

// SetCellDimensions updates the cell dimensions (the TUI calls this after the
// terminal answers the pixel-size query).
func SetCellDimensions(d CellDimensions) { cellDimensions = d }

// probeTmuxHyperlinks reports whether the attached tmux client forwards OSC 8
// hyperlinks. Mirrors terminal-image.probeTmuxHyperlinks: tmux only re-emits
// them when client_termfeatures lists "hyperlinks". Any error → false.
func probeTmuxHyperlinks() bool {
	ctx, cancel := contextTimeout(250 * time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, "tmux", "display-message", "-p", "#{client_termfeatures}")
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	for _, feature := range strings.Split(string(out), ",") {
		if strings.TrimSpace(feature) == "hyperlinks" {
			return true
		}
	}
	return false
}

// DetectCapabilities inspects the environment to decide image protocol,
// truecolor, and hyperlink support. tmuxForwardsHyperlink is injected so tests
// can force the tmux forward probe; pass nil to use the live probe. Faithful
// port of terminal-image.detectCapabilities.
func DetectCapabilities(tmuxForwardsHyperlink func() bool) Capabilities {
	if tmuxForwardsHyperlink == nil {
		tmuxForwardsHyperlink = probeTmuxHyperlinks
	}
	termProgram := strings.ToLower(os.Getenv("TERM_PROGRAM"))
	terminalEmulator := strings.ToLower(os.Getenv("TERMINAL_EMULATOR"))
	term := strings.ToLower(os.Getenv("TERM"))
	colorTerm := strings.ToLower(os.Getenv("COLORTERM"))
	hasTrueColorHint := colorTerm == "truecolor" || colorTerm == "24bit"

	// tmux: OSC 8 only when forwarded; image protocols unreliable → none.
	if os.Getenv("TMUX") != "" || strings.HasPrefix(term, "tmux") {
		return Capabilities{Images: ProtocolNone, TrueColor: hasTrueColorHint, Hyperlinks: tmuxForwardsHyperlink()}
	}

	// screen does not forward OSC 8 hyperlinks.
	if strings.HasPrefix(term, "screen") {
		return Capabilities{Images: ProtocolNone, TrueColor: hasTrueColorHint, Hyperlinks: false}
	}

	if os.Getenv("KITTY_WINDOW_ID") != "" || termProgram == "kitty" {
		return Capabilities{Images: ProtocolKitty, TrueColor: true, Hyperlinks: true}
	}
	if termProgram == "ghostty" || strings.Contains(term, "ghostty") || os.Getenv("GHOSTTY_RESOURCES_DIR") != "" {
		return Capabilities{Images: ProtocolKitty, TrueColor: true, Hyperlinks: true}
	}
	if os.Getenv("WEZTERM_PANE") != "" || termProgram == "wezterm" {
		return Capabilities{Images: ProtocolKitty, TrueColor: true, Hyperlinks: true}
	}
	if termProgram == "warpterminal" || os.Getenv("WARP_SESSION_ID") != "" || os.Getenv("WARP_TERMINAL_SESSION_UUID") != "" {
		return Capabilities{Images: ProtocolKitty, TrueColor: true, Hyperlinks: true}
	}
	if os.Getenv("ITERM_SESSION_ID") != "" || termProgram == "iterm.app" {
		return Capabilities{Images: ProtocolITerm2, TrueColor: true, Hyperlinks: true}
	}
	if os.Getenv("WT_SESSION") != "" {
		return Capabilities{Images: ProtocolNone, TrueColor: true, Hyperlinks: true}
	}
	if termProgram == "vscode" {
		return Capabilities{Images: ProtocolNone, TrueColor: true, Hyperlinks: true}
	}
	if termProgram == "alacritty" {
		return Capabilities{Images: ProtocolNone, TrueColor: true, Hyperlinks: true}
	}
	if terminalEmulator == "jetbrains-jediterm" {
		return Capabilities{Images: ProtocolNone, TrueColor: true, Hyperlinks: false}
	}

	// Unknown terminal: conservative. OSC 8 hidden as plain text on terminals
	// that swallow it, so default hyperlinks off unless positively identified.
	return Capabilities{Images: ProtocolNone, TrueColor: hasTrueColorHint, Hyperlinks: false}
}

// GetCapabilities returns the cached detected capabilities, computing them on
// first use. Mirrors terminal-image.getCapabilities.
func GetCapabilities() Capabilities {
	if cachedCaps == nil {
		caps := DetectCapabilities(nil)
		cachedCaps = &caps
	}
	return *cachedCaps
}

// ResetCapabilitiesCache clears the capability cache.
func ResetCapabilitiesCache() { cachedCaps = nil }

// SetCapabilities overrides the cached capabilities (tests exercise both paths).
func SetCapabilities(c Capabilities) { cachedCaps = &c }

const (
	kittyPrefix  = "\x1b_G"
	iterm2Prefix = "\x1b]1337;File="
)

// IsImageLine reports whether a rendered line contains an inline-image escape
// sequence (which must not be wrapped). Fast path checks the line start; slow
// path scans the whole line. Port of terminal-image.isImageLine.
func IsImageLine(line string) bool {
	if strings.HasPrefix(line, kittyPrefix) || strings.HasPrefix(line, iterm2Prefix) {
		return true
	}
	return strings.Contains(line, kittyPrefix) || strings.Contains(line, iterm2Prefix)
}

// KittyOptions parameterizes EncodeKitty. MoveCursor defaults to true when nil;
// when explicitly false, C=1 is emitted to suppress terminal-side cursor
// movement. Mirrors terminal-image.encodeKitty options.
type KittyOptions struct {
	Columns    int
	Rows       int
	ImageID    int
	MoveCursor *bool
}

const kittyChunkSize = 4096

// EncodeKitty encodes base64 image data as a kitty graphics APC sequence,
// chunking large payloads at 4096 bytes. Port of terminal-image.encodeKitty.
func EncodeKitty(base64Data string, opts KittyOptions) string {
	params := []string{"a=T", "f=100", "q=2"}
	if opts.MoveCursor != nil && !*opts.MoveCursor {
		params = append(params, "C=1")
	}
	if opts.Columns != 0 {
		params = append(params, "c="+itoa(opts.Columns))
	}
	if opts.Rows != 0 {
		params = append(params, "r="+itoa(opts.Rows))
	}
	if opts.ImageID != 0 {
		params = append(params, "i="+itoa(opts.ImageID))
	}

	if len(base64Data) <= kittyChunkSize {
		return "\x1b_G" + strings.Join(params, ",") + ";" + base64Data + "\x1b\\"
	}

	var b strings.Builder
	offset := 0
	first := true
	for offset < len(base64Data) {
		end := offset + kittyChunkSize
		if end > len(base64Data) {
			end = len(base64Data)
		}
		chunk := base64Data[offset:end]
		isLast := end >= len(base64Data)
		switch {
		case first:
			b.WriteString("\x1b_G" + strings.Join(params, ",") + ",m=1;" + chunk + "\x1b\\")
			first = false
		case isLast:
			b.WriteString("\x1b_Gm=0;" + chunk + "\x1b\\")
		default:
			b.WriteString("\x1b_Gm=1;" + chunk + "\x1b\\")
		}
		offset = end
	}
	return b.String()
}

// DeleteKittyImage returns the sequence to delete a kitty image by ID (uppercase
// I also frees the data). q=2 suppresses replies. Port of deleteKittyImage.
func DeleteKittyImage(imageID int) string {
	return "\x1b_Ga=d,d=I,i=" + itoa(imageID) + ",q=2\x1b\\"
}

// DeleteAllKittyImages returns the sequence to delete all visible kitty images.
// Port of deleteAllKittyImages.
func DeleteAllKittyImages() string {
	return "\x1b_Ga=d,d=A,q=2\x1b\\"
}

// ITerm2Options parameterizes EncodeITerm2.
type ITerm2Options struct {
	Width               string
	Height              string
	PreserveAspectRatio *bool
	Inline              *bool
}

// EncodeITerm2 encodes base64 image data as an iTerm2 OSC 1337 sequence. Port of
// terminal-image.encodeITerm2 (name option omitted — unused by neo callers).
func EncodeITerm2(base64Data string, opts ITerm2Options) string {
	inline := 1
	if opts.Inline != nil && !*opts.Inline {
		inline = 0
	}
	params := []string{"inline=" + itoa(inline)}
	if opts.Width != "" {
		params = append(params, "width="+opts.Width)
	}
	if opts.Height != "" {
		params = append(params, "height="+opts.Height)
	}
	if opts.PreserveAspectRatio != nil && !*opts.PreserveAspectRatio {
		params = append(params, "preserveAspectRatio=0")
	}
	return "\x1b]1337;File=" + strings.Join(params, ";") + ":" + base64Data + "\x07"
}

// ImageCellSize is an image footprint in terminal cells.
type ImageCellSize struct {
	Columns int
	Rows    int
}

// CalculateImageCellSize scales an image to fit within maxWidthCells (and
// optional maxHeightCells) preserving aspect ratio, in whole cells. Port of
// terminal-image.calculateImageCellSize.
func CalculateImageCellSize(img ImageDimensions, maxWidthCells int, maxHeightCells *int, cell CellDimensions) ImageCellSize {
	maxWidth := maxi(1, maxWidthCells)
	imageWidth := maxi(1, img.WidthPx)
	imageHeight := maxi(1, img.HeightPx)

	widthScale := float64(maxWidth*cell.WidthPx) / float64(imageWidth)
	var heightScale float64
	var maxHeight int
	if maxHeightCells == nil {
		heightScale = widthScale
	} else {
		maxHeight = maxi(1, *maxHeightCells)
		heightScale = float64(maxHeight*cell.HeightPx) / float64(imageHeight)
	}
	scale := widthScale
	if heightScale < scale {
		scale = heightScale
	}

	scaledWidthPx := float64(imageWidth) * scale
	scaledHeightPx := float64(imageHeight) * scale
	columns := ceilDiv(scaledWidthPx, float64(cell.WidthPx))
	rows := ceilDiv(scaledHeightPx, float64(cell.HeightPx))

	outCols := clampi(columns, 1, maxWidth)
	var outRows int
	if maxHeightCells == nil {
		outRows = maxi(1, rows)
	} else {
		outRows = clampi(rows, 1, maxHeight)
	}
	return ImageCellSize{Columns: outCols, Rows: outRows}
}

// RenderOptions parameterizes RenderImage. MoveCursor mirrors the kitty option.
type RenderOptions struct {
	MaxWidthCells       int
	MaxHeightCells      *int
	PreserveAspectRatio *bool
	ImageID             int
	MoveCursor          *bool
}

// RenderResult is a rendered image escape sequence + its cell height.
type RenderResult struct {
	Sequence string
	Rows     int
	ImageID  int
}

// RenderImage produces the protocol escape sequence for the detected terminal,
// or nil when no inline-image protocol is available (caller falls back to a
// text placeholder). Port of terminal-image.renderImage.
func RenderImage(base64Data string, img ImageDimensions, opts RenderOptions) *RenderResult {
	caps := GetCapabilities()
	if caps.Images == ProtocolNone {
		return nil
	}
	maxWidth := opts.MaxWidthCells
	if maxWidth == 0 {
		maxWidth = 80
	}
	size := CalculateImageCellSize(img, maxWidth, opts.MaxHeightCells, GetCellDimensions())

	switch caps.Images {
	case ProtocolKitty:
		seq := EncodeKitty(base64Data, KittyOptions{
			Columns:    size.Columns,
			Rows:       size.Rows,
			ImageID:    opts.ImageID,
			MoveCursor: opts.MoveCursor,
		})
		return &RenderResult{Sequence: seq, Rows: size.Rows, ImageID: opts.ImageID}
	case ProtocolITerm2:
		preserve := true
		if opts.PreserveAspectRatio != nil {
			preserve = *opts.PreserveAspectRatio
		}
		seq := EncodeITerm2(base64Data, ITerm2Options{
			Width:               itoa(size.Columns),
			Height:              "auto",
			PreserveAspectRatio: &preserve,
		})
		return &RenderResult{Sequence: seq, Rows: size.Rows}
	default:
		return nil
	}
}

// Hyperlink wraps text in an OSC 8 hyperlink sequence. Port of
// terminal-image.hyperlink.
func Hyperlink(text, url string) string {
	return "\x1b]8;;" + url + "\x1b\\" + text + "\x1b]8;;\x1b\\"
}

// ImageFallback returns the text placeholder shown when inline images are
// unsupported (or disabled). Port of terminal-image.imageFallback.
func ImageFallback(mimeType string, dims *ImageDimensions, filename string) string {
	var parts []string
	if filename != "" {
		parts = append(parts, filename)
	}
	parts = append(parts, "["+mimeType+"]")
	if dims != nil {
		parts = append(parts, itoa(dims.WidthPx)+"x"+itoa(dims.HeightPx))
	}
	return "[Image: " + strings.Join(parts, " ") + "]"
}
