package ui

import "github.com/code-yeongyu/senpi/packages/neo/internal/theme"

// Loader is the grok spinner+message primitive, ported from
// packages/tui/src/components/loader.ts. In bubbletea neo drives the frame with a
// tick command rather than a Node interval, so Loader here is a pure state
// holder: it owns the current braille frame + message and composes the display
// line "<colored-frame> <colored-message>". An empty frame set hides the
// indicator (the message renders alone), matching the TS "indicator hidden"
// path. Frames default to the theme's braille spinner family (incl. the grok ⠹).
// LoaderMessageFormatter mirrors the TS LoaderMessageFormatter: given the
// message and the elapsed animation time (ms), it returns the rendered message
// span. When set it REPLACES the message color fn (loader.ts updateDisplay).
type LoaderMessageFormatter func(message string, animationElapsedMs int64) string

// LoaderIndicatorFormatter mirrors the TS LoaderIndicatorFormatter: given the
// current frame glyph and the elapsed animation time (ms), it returns the
// rendered indicator span. When set it REPLACES the verbatim/colored frame.
type LoaderIndicatorFormatter func(frame string, animationElapsedMs int64) string

type Loader struct {
	th           *theme.Theme
	frames       []string
	currentFrame int
	message      string
	spinnerColor func(string) string
	messageColor func(string) string

	// messageFormatter / indicatorFormatter port the loader.ts callback API. In
	// the classic TUI a timer feeds animationElapsedMs; in neo the frame is
	// driven by a bubbletea tick, so the driver advances elapsedMs explicitly
	// (SetAnimationElapsedMs). elapsedMs is a plain int64 and therefore always
	// finite (the TS test asserts Number.isFinite(animationElapsedMs)).
	messageFormatter   LoaderMessageFormatter
	indicatorFormatter LoaderIndicatorFormatter
	// indicatorVerbatim mirrors renderIndicatorVerbatim: when an explicit
	// indicator options object is supplied, the frame is rendered as-is rather
	// than through the spinner color fn (loader.ts setIndicator).
	indicatorVerbatim bool
	elapsedMs         int64
}

// NewLoader builds a Loader with the theme's default braille frames, the spinner
// colored in accent-cyan and the message in muted text (grok waiting-row style).
func NewLoader(th *theme.Theme, message string) *Loader {
	return &Loader{
		th:           th,
		frames:       th.SpinnerFrames(),
		message:      message,
		spinnerColor: func(s string) string { return th.AccentCyan().Render(s) },
		messageColor: func(s string) string { return th.TextMuted().Render(s) },
	}
}

// SetFrames overrides the animation frames. An empty/nil slice hides the
// indicator. Resets the current frame to the first.
func (l *Loader) SetFrames(frames []string) {
	l.frames = frames
	l.currentFrame = 0
}

// SetMessage updates the message text.
func (l *Loader) SetMessage(message string) { l.message = message }

// SetColors overrides the spinner and message colorizers (used to match a
// specific status style; nil keeps the current fn).
func (l *Loader) SetColors(spinner, message func(string) string) {
	if spinner != nil {
		l.spinnerColor = spinner
	}
	if message != nil {
		l.messageColor = message
	}
}

// SetMessageFormatter installs a message formatter (loader.ts messageFormatter).
// When set it replaces the message color fn: the formatter receives the message
// and the current elapsed animation time and returns the message span. Passing
// nil clears it, restoring the color-fn path.
func (l *Loader) SetMessageFormatter(fn LoaderMessageFormatter) { l.messageFormatter = fn }

// SetIndicatorFormatter installs an indicator formatter (loader.ts
// indicatorFormatter). When set it replaces the verbatim/colored frame: the
// formatter receives the frame glyph and the elapsed animation time. Passing nil
// clears it.
func (l *Loader) SetIndicatorFormatter(fn LoaderIndicatorFormatter) { l.indicatorFormatter = fn }

// SetIndicatorVerbatim controls whether the frame renders as-is (true) or through
// the spinner color fn (false). Mirrors renderIndicatorVerbatim, set true when an
// explicit indicator options object is supplied in the classic TUI.
func (l *Loader) SetIndicatorVerbatim(v bool) { l.indicatorVerbatim = v }

// SetAnimationElapsedMs sets the elapsed animation time passed to the formatters.
// The bubbletea tick driver advances this; it is always finite/non-negative.
func (l *Loader) SetAnimationElapsedMs(ms int64) {
	if ms < 0 {
		ms = 0
	}
	l.elapsedMs = ms
}

// Frame returns the current (uncolored) frame glyph, or "" when hidden.
func (l *Loader) Frame() string {
	if len(l.frames) == 0 {
		return ""
	}
	return l.frames[l.currentFrame%len(l.frames)]
}

// Advance moves to the next frame (wrapping). No-op when the indicator is hidden.
func (l *Loader) Advance() {
	if len(l.frames) == 0 {
		return
	}
	l.currentFrame = (l.currentFrame + 1) % len(l.frames)
}

// Line composes the display line, mirroring loader.ts updateDisplay:
//
//	indicator = frame != ""  ? renderedFrame + " " : ""
//	rendered  = indicatorFormatter ? indicatorFormatter(frame, elapsed)
//	                                : verbatim ? frame : spinnerColor(frame)
//	message   = messageFormatter ? messageFormatter(message, elapsed)
//	                             : messageColor(message)
//	line      = indicator + message
//
// When the indicator is hidden (no frames) only the (formatted) message renders.
func (l *Loader) Line() string {
	frame := l.Frame()

	msg := l.messageColor(l.message)
	if l.messageFormatter != nil {
		msg = l.messageFormatter(l.message, l.elapsedMs)
	}

	if frame == "" {
		return msg
	}

	var rendered string
	switch {
	case l.indicatorFormatter != nil:
		rendered = l.indicatorFormatter(frame, l.elapsedMs)
	case l.indicatorVerbatim:
		rendered = frame
	default:
		rendered = l.spinnerColor(frame)
	}
	return rendered + " " + msg
}

// Render returns the loader as a single-line slice (leading blank omitted; the
// shell owns vertical spacing). width is unused — the message is not truncated
// here (callers wrap in a TruncatedText when a width bound is needed).
func (l *Loader) Render(_ int) []string {
	return []string{l.Line()}
}

// CancellableLoader is a Loader that can be aborted (Esc in the classic TUI).
// Port of packages/tui/src/components/cancellable-loader.ts: Cancel() flips the
// aborted flag once and invokes OnAbort.
type CancellableLoader struct {
	*Loader
	aborted bool
	// OnAbort is called the first time the loader is cancelled.
	OnAbort func()
}

// NewCancellableLoader builds a cancellable loader.
func NewCancellableLoader(th *theme.Theme, message string) *CancellableLoader {
	return &CancellableLoader{Loader: NewLoader(th, message)}
}

// Aborted reports whether the loader has been cancelled.
func (c *CancellableLoader) Aborted() bool { return c.aborted }

// Cancel aborts the loader (idempotent) and fires OnAbort on the first call.
func (c *CancellableLoader) Cancel() {
	if c.aborted {
		return
	}
	c.aborted = true
	if c.OnAbort != nil {
		c.OnAbort()
	}
}
