package markdown

import "strings"

// trimPartialClosingFences trims a streamed partial closing fence from the last
// code block so code blocks do not shrink/flicker when the final fence character
// arrives. Faithful port of markdown.ts trimPartialClosingFences (see pi #5825).
//
// It recurses into the last child of a trailing list/blockquote, exactly as pi
// does, and only acts on a trailing `code` token.
func trimPartialClosingFences(tokens []block) {
	if len(tokens) == 0 {
		return
	}
	last := &tokens[len(tokens)-1]

	switch last.typ {
	case tokList:
		if n := len(last.items); n > 0 {
			trimPartialClosingFences(last.items[n-1].tokens)
		}
		return
	case tokBlockquote:
		trimPartialClosingFences(last.children)
		return
	case tokCode:
		// fall through
	default:
		return
	}

	marker := fenceMarkerRe.FindString(last.raw)
	if marker == "" {
		return
	}
	rawLines := strings.Split(last.raw, "\n")
	lastLine := rawLines[len(rawLines)-1]
	if lastLine == "" {
		return
	}
	// A partial closing fence is shorter than the opening marker and composed
	// entirely of the marker's fence character (e.g. "``" for a "```" fence).
	fenceChar := marker[0:1]
	if len(lastLine) >= len(marker) || lastLine != strings.Repeat(fenceChar, len(lastLine)) {
		return
	}
	// Remove the partial fence line's characters from the code text and drop a
	// dangling trailing newline (mirrors token.text.slice(0,-lastLine.length)
	// followed by .replace(/\n$/, "")).
	if len(lastLine) <= len(last.codeText) {
		last.codeText = last.codeText[:len(last.codeText)-len(lastLine)]
	} else {
		last.codeText = ""
	}
	last.codeText = strings.TrimSuffix(last.codeText, "\n")
}
