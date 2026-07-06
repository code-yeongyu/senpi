package markdown

import "strings"

// asciiPunct is the CommonMark backslash-escapable punctuation set.
const asciiPunct = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"

// normalizeEscapes turns "\<punct>" into "<punct>" (CommonMark backslash escape
// resolution), unless PreserveBackslashEscapes is set. goldmark keeps the raw
// source text on Text nodes, so we resolve escapes here to match marked.
func (m *Markdown) normalizeEscapes(text string) string {
	if m.options.PreserveBackslashEscapes {
		return text
	}
	if !strings.ContainsRune(text, '\\') {
		return text
	}
	var b strings.Builder
	b.Grow(len(text))
	for i := 0; i < len(text); i++ {
		if text[i] == '\\' && i+1 < len(text) && strings.IndexByte(asciiPunct, text[i+1]) >= 0 {
			b.WriteByte(text[i+1])
			i++
			continue
		}
		b.WriteByte(text[i])
	}
	return b.String()
}

// isImageLine reports whether a rendered line is an inline-image escape line that
// must not be wrapped. Mirrors pi terminal-image.isImageLine (kitty/iterm2 use
// APC/OSC sequences). neo does not emit inline images from markdown yet, so this
// only guards against pre-embedded image escape lines.
func isImageLine(line string) bool {
	// kitty graphics: ESC _ G ... ST ; iterm2: ESC ] 1337 ; ...
	return strings.HasPrefix(line, "\x1b_G") || strings.HasPrefix(line, "\x1b]1337;")
}

// hyperlink wraps text in an OSC 8 hyperlink sequence. Port of
// terminal-image.hyperlink.
func hyperlink(text, url string) string {
	return "\x1b]8;;" + url + "\x1b\\" + text + "\x1b]8;;\x1b\\"
}
