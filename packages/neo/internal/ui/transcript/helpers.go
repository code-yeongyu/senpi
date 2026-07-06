package transcript

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var controlRunRe = regexp.MustCompile(`[\x00-\x1f\x7f-\x9f]+`)
var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)
var wsRunRe = regexp.MustCompile(`\s+`)

// capitalize upper-cases the first rune, matching the grok verb display.
func capitalize(s string) string {
	if s == "" {
		return s
	}
	r := []rune(s)
	r[0] = unicode.ToUpper(r[0])
	return string(r)
}

// sanitizeInline strips ANSI, collapses control chars + whitespace to single
// spaces, and trims. Mirrors tool-execution.ts sanitizeFallbackString (used for
// the header-row command summary).
func sanitizeInline(value string) string {
	s := ansiRe.ReplaceAllString(value, "")
	s = controlRunRe.ReplaceAllString(s, " ")
	s = wsRunRe.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// sanitizeMultiline strips ANSI and normalizes CR out of body output while
// preserving newlines, mirroring getTextOutput's stripAnsi + \r removal.
func sanitizeMultiline(value string) string {
	s := ansiRe.ReplaceAllString(value, "")
	return strings.ReplaceAll(s, "\r", "")
}

// bold wraps text in SGR bold on/off. Mirrors the classic components' literal
// `\x1b[1m…\x1b[22m` label formatting so the grok label weight is preserved.
func bold(s string) string { return "\x1b[1m" + s + "\x1b[22m" }

// italic wraps text in SGR italic on/off.
func italic(s string) string { return "\x1b[3m" + s + "\x1b[23m" }

func itoaSigned(n int) string { return strconv.Itoa(n) }

// wrapZone brackets the first/last rendered lines with OSC 133 prompt-zone
// markers, matching user-message.ts / assistant-message.ts. An empty slice is
// returned unchanged.
func wrapZone(lines []string) []string {
	if len(lines) == 0 {
		return lines
	}
	out := make([]string, len(lines))
	copy(out, lines)
	out[0] = osc133ZoneStart + out[0]
	out[len(out)-1] = osc133ZoneEnd + osc133ZoneFinal + out[len(out)-1]
	return out
}

// wrapZoneIfNoTools applies the OSC 133 zone markers only when the message has
// no tool calls, matching assistant-message.ts (tool-call turns skip the zone
// because the tool blocks render separately).
func wrapZoneIfNoTools(lines []string, hasToolCalls bool) []string {
	if hasToolCalls || len(lines) == 0 {
		return lines
	}
	return wrapZone(lines)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
