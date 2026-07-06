// Package markdown renders pi-flavored markdown to terminal lines with grok
// styling supplied through internal/theme. It is a contract-faithful Go port of
// packages/tui/src/components/markdown.ts.
//
// The renderer is deliberately custom (not glamour): the pi contract pins
// byte-exact list markers, blockquote borders, table box drawing, spacing rules,
// and streaming partial-fence stabilization that glamour's whole-document
// renderer cannot reproduce (see task-7 evidence spike). Tokenization is done by
// goldmark (+GFM) with pi-specific post-processing (strict double-tilde
// strikethrough, ordered-marker normalization, partial-fence trimming).
//
// Core streaming invariant: once a source line is finalized, it never reflows.
// Rendering is pure over (text, width, theme, options, capabilities); a bounded
// per-instance + shared cache keyed on that tuple guarantees stable prefixes as
// text streams in.
package markdown

// StyleFunc styles a run of text by wrapping it in ANSI escapes. It mirrors the
// pi MarkdownTheme member signature `(text: string) => string`.
type StyleFunc func(string) string

// Theme carries every styling function the renderer applies. It mirrors pi's
// MarkdownTheme. HighlightCode is optional (nil disables syntax highlighting and
// code blocks render via CodeBlock line-by-line). CodeBlockIndent defaults to two
// spaces when empty.
type Theme struct {
	Heading         StyleFunc
	Link            StyleFunc
	LinkURL         StyleFunc
	Code            StyleFunc
	CodeBlock       StyleFunc
	CodeBlockBorder StyleFunc
	Quote           StyleFunc
	QuoteBorder     StyleFunc
	HR              StyleFunc
	ListBullet      StyleFunc
	Bold            StyleFunc
	Italic          StyleFunc
	Strikethrough   StyleFunc
	Underline       StyleFunc

	// HighlightCode returns pre-styled lines for a fenced code block. nil = none.
	HighlightCode func(code, lang string) []string
	// CodeBlockIndent prefixes each rendered code line (default "  ").
	CodeBlockIndent string
}

// DefaultTextStyle is the base styling applied to all non-block text, used for
// pre-styled content such as thinking traces. Mirrors pi's DefaultTextStyle.
// Color/BgColor are functions so callers can supply arbitrary ANSI wrappers.
type DefaultTextStyle struct {
	Color         StyleFunc
	BgColor       StyleFunc
	Bold          bool
	Italic        bool
	Strikethrough bool
	Underline     bool
}

// Options toggles pi-compatible source-preservation behaviors.
type Options struct {
	// PreserveOrderedListMarkers keeps source list markers instead of
	// normalizing ordered markers to sequential `N. `.
	PreserveOrderedListMarkers bool
	// PreserveBackslashEscapes keeps source backslash escapes instead of
	// normalizing escaped punctuation.
	PreserveBackslashEscapes bool
}
