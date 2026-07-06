package ui

import (
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
)

// borderRune is the horizontal rule glyph used by the grok TUI dividers.
const borderRune = "─"

// DynamicBorder renders a single horizontal rule that spans the render width,
// styled with the theme's input-border color. Port of the coding-agent
// interactive-components dynamic-border.ts (`─`.repeat(max(1,width))).
type DynamicBorder struct {
	th    *theme.Theme
	color func(string) string
}

// NewDynamicBorder builds a DynamicBorder colored with the theme's card/input
// border tier (grok divider color).
func NewDynamicBorder(th *theme.Theme) *DynamicBorder {
	return &DynamicBorder{
		th:    th,
		color: func(s string) string { return th.BorderInput().Render(s) },
	}
}

// NewDynamicBorderColored builds a DynamicBorder with an explicit color fn (used
// when a caller needs a non-default rule color, e.g. an accent divider).
func NewDynamicBorderColored(color func(string) string) *DynamicBorder {
	return &DynamicBorder{color: color}
}

// Render returns exactly one rule line at least 1 cell wide.
func (b *DynamicBorder) Render(width int) []string {
	if width < 1 {
		width = 1
	}
	rule := strings.Repeat(borderRune, width)
	if b.color != nil {
		rule = b.color(rule)
	}
	return []string{rule}
}
