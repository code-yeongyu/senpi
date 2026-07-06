package shell

import (
	"path/filepath"
	"strings"
)

// TitleSequence builds the OSC 0 set-window-title escape for title, stripping
// control characters so an embedded BEL/ESC cannot terminate the OSC early and
// leak the remainder onto the screen. Port of tui/terminal.ts setTitle:
//
//	\x1b]0;<sanitized>\x07
//
// The sanitizer removes C0 (U+0000..U+001F) and C1 (U+007F..U+009F) control
// characters, matching the classic control-char strip in terminal.ts.
func TitleSequence(title string) string {
	return "\x1b]0;" + sanitizeTitle(title) + "\x07"
}

// sanitizeTitle removes C0/C1 control characters from s.
func sanitizeTitle(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if (r >= 0x00 && r <= 0x1f) || (r >= 0x7f && r <= 0x9f) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// NormalTitle builds the neo normal terminal title, mirroring interactive-mode
// getNormalTerminalTitle: "<app> - <session> - <cwd-basename>" when a session
// name is set, else "<app> - <cwd-basename>".
func NormalTitle(app, sessionName, cwd string) string {
	base := filepath.Base(cwd)
	if sessionName != "" {
		return app + " - " + sessionName + " - " + base
	}
	return app + " - " + base
}
