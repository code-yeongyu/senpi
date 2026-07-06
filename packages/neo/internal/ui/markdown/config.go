package markdown

import (
	"github.com/yuin/goldmark"
	gast "github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	extast "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// gfmMarkdown returns the goldmark options used to tokenize pi-flavored markdown:
// GFM tables, task lists, autolinking, and a STRICT double-tilde strikethrough
// (single-tilde stays literal, matching pi's StrictStrikethroughTokenizer).
func gfmMarkdown() []goldmark.Option {
	return []goldmark.Option{
		goldmark.WithExtensions(
			extension.Table,
			extension.TaskList,
			extension.Linkify,
			strictStrikethrough{},
		),
		goldmark.WithParserOptions(
			parser.WithAttribute(),
		),
	}
}

// strictStrikethrough registers a strikethrough parser that only fires on
// exactly two tildes, so `~text~` renders literally while `~~text~~` is struck.
type strictStrikethrough struct{}

func (strictStrikethrough) Extend(m goldmark.Markdown) {
	m.Parser().AddOptions(
		parser.WithInlineParsers(
			util.Prioritized(&strictStrikeParser{}, 500),
		),
	)
}

type strictStrikeParser struct{}

var strictDelimProc = &strictStrikeDelimiterProcessor{}

func (s *strictStrikeParser) Trigger() []byte { return []byte{'~'} }

func (s *strictStrikeParser) Parse(parent gast.Node, block text.Reader, pc parser.Context) gast.Node {
	before := block.PrecendingCharacter()
	line, segment := block.PeekLine()
	node := parser.ScanDelimiter(line, before, 1, strictDelimProc)
	if node == nil {
		return nil
	}
	// STRICT: only exactly two tildes participate (pi contract).
	if node.OriginalLength != 2 || before == '~' {
		return nil
	}
	node.Segment = segment.WithStop(segment.Start + node.OriginalLength)
	block.Advance(node.OriginalLength)
	pc.PushDelimiter(node)
	return node
}

func (s *strictStrikeParser) CloseBlock(parent gast.Node, pc parser.Context) {}

type strictStrikeDelimiterProcessor struct{}

func (p *strictStrikeDelimiterProcessor) IsDelimiter(b byte) bool { return b == '~' }

func (p *strictStrikeDelimiterProcessor) CanOpenCloser(opener, closer *parser.Delimiter) bool {
	return opener.Char == closer.Char && opener.OriginalLength == 2 && closer.OriginalLength == 2
}

func (p *strictStrikeDelimiterProcessor) OnMatch(consumes int) gast.Node {
	return extast.NewStrikethrough()
}
