package markdown

import (
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/text"
)

// The token model mirrors the subset of `marked`'s token tree that
// packages/tui/src/components/markdown.ts consumes. Block tokens are produced by
// walking the goldmark AST (+GFM); inline tokens preserve the ordering the
// renderer needs to restyle after resets. pi-specific behaviors (strict
// double-tilde strikethrough via the GFM parser config, ordered-marker
// normalization, partial-fence trimming) are applied here so the renderer stays
// a faithful port of markdown.ts.

type tokenType int

const (
	tokHeading tokenType = iota
	tokParagraph
	tokText
	tokCode // fenced/indented code block
	tokList
	tokTable
	tokBlockquote
	tokHR
	tokHTML
	tokSpace
	// inline
	tokInlineText
	tokEscape
	tokStrong
	tokEm
	tokCodespan
	tokLink
	tokBr
	tokDel
	tokInlineHTML
)

// block is a block-level token.
type block struct {
	typ tokenType

	// heading
	depth int

	// code
	codeText string
	codeLang string

	// list
	ordered    bool
	start      int
	loose      bool
	items      []listItem
	listMarker byte // source marker rune for the list ('-','+','*','.',')')

	// html / raw
	raw string

	// inline content (heading, paragraph, text)
	inline []inline

	// blockquote / table children
	children []block
	table    *tableToken
}

type listItem struct {
	// tokens are the block children of the item (paragraph/list/code/blockquote).
	tokens []block
	// task marker
	task    bool
	checked bool
	// srcMarker is the exact source marker string incl. trailing punctuation,
	// e.g. "4." or "10)" or "-" (without trailing space).
	srcMarker string
}

type tableToken struct {
	header []tableCell
	rows   [][]tableCell
	raw    string
}

type tableCell struct {
	inline []inline
}

// inline is an inline token.
type inline struct {
	typ  tokenType
	text string // text/escape/codespan/inlineHTML raw text
	// link
	href string
	// children (strong/em/del/link/text-with-children)
	children []inline
}

// parseDocument tokenizes src into block tokens with pi semantics applied.
func parseDocument(src string, opts Options) []block {
	source := []byte(src)
	md := goldmark.New(gfmMarkdown()...)
	reader := text.NewReader(source)
	doc := md.Parser().Parse(reader)

	blocks := walkBlocks(doc, source, opts)
	blocks = insertSpaceTokens(doc, blocks)
	trimPartialClosingFences(blocks)
	return blocks
}
