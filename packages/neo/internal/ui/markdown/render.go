package markdown

import "strings"

// Markdown is a single renderable markdown block. Construct it with New and call
// Render(width). Instances are cheap; a shared bounded cache backs repeated
// renders across instances so streaming re-renders reuse stable output.
type Markdown struct {
	text             string
	paddingX         int
	paddingY         int
	theme            Theme
	defaultTextStyle *DefaultTextStyle
	options          Options

	// per-instance memo of the last render.
	cachedText  string
	cachedWidth int
	cachedLines []string
	cachedValid bool

	// memoized style prefix for the default text style.
	defaultStylePrefix    string
	defaultStylePrefixSet bool
}

// New builds a Markdown block. defaultTextStyle and opts may be nil / zero.
func New(text string, paddingX, paddingY int, theme Theme, defaultTextStyle *DefaultTextStyle, opts *Options) *Markdown {
	m := &Markdown{
		text:             text,
		paddingX:         paddingX,
		paddingY:         paddingY,
		theme:            theme,
		defaultTextStyle: defaultTextStyle,
	}
	if opts != nil {
		m.options = *opts
	}
	return m
}

// SetText replaces the source text and invalidates the cache.
func (m *Markdown) SetText(text string) {
	m.text = text
	m.Invalidate()
}

// Invalidate drops the per-instance render memo.
func (m *Markdown) Invalidate() {
	m.cachedValid = false
	m.cachedLines = nil
}

// Render lays the markdown out to at most width visible columns per line,
// returning styled terminal lines. Faithful port of markdown.ts Markdown.render.
func (m *Markdown) Render(width int) []string {
	if m.cachedValid && m.cachedText == m.text && m.cachedWidth == width {
		return m.cachedLines
	}

	contentWidth := width - m.paddingX*2
	if contentWidth < 1 {
		contentWidth = 1
	}

	if strings.TrimSpace(m.text) == "" {
		m.cachedText = m.text
		m.cachedWidth = width
		m.cachedLines = []string{}
		m.cachedValid = true
		return m.cachedLines
	}

	normalized := strings.ReplaceAll(m.text, "\t", "   ")

	// Shared bounded cache keyed on the pure render inputs.
	caps := GetCapabilities()
	key := renderKey{
		text:           normalized,
		width:          width,
		contentWidth:   contentWidth,
		paddingX:       m.paddingX,
		paddingY:       m.paddingY,
		codeIndent:     m.codeBlockIndent(),
		preserveOrd:    m.options.PreserveOrderedListMarkers,
		preserveEsc:    m.options.PreserveBackslashEscapes,
		themeID:        themeID(m.theme),
		defaultStyleID: defaultStyleID(m.defaultTextStyle),
		images:         caps.Images,
		hyperlinks:     caps.Hyperlinks,
	}
	if cached, ok := getSharedRender(key); ok {
		m.cachedText = m.text
		m.cachedWidth = width
		m.cachedLines = cached
		m.cachedValid = true
		return cached
	}

	tokens := getParsedTokens(normalized, m.options)

	// Convert tokens to styled terminal lines.
	var rendered []string
	for i := range tokens {
		var nextType tokenType = -1
		if i+1 < len(tokens) {
			nextType = tokens[i+1].typ
		}
		rendered = append(rendered, m.renderToken(&tokens[i], contentWidth, nextType, nil)...)
	}

	// Wrap lines (no padding, no background yet).
	var wrapped []string
	for _, line := range rendered {
		if isImageLine(line) {
			wrapped = append(wrapped, line)
			continue
		}
		wrapped = append(wrapped, wrapTextWithAnsi(line, contentWidth)...)
	}

	// Add margins + background.
	leftMargin := strings.Repeat(" ", m.paddingX)
	rightMargin := strings.Repeat(" ", m.paddingX)
	var bgFn StyleFunc
	if m.defaultTextStyle != nil {
		bgFn = m.defaultTextStyle.BgColor
	}
	var contentLines []string
	for _, line := range wrapped {
		if isImageLine(line) {
			contentLines = append(contentLines, line)
			continue
		}
		lineWithMargins := leftMargin + line + rightMargin
		if bgFn != nil {
			contentLines = append(contentLines, applyBackgroundToLine(lineWithMargins, width, bgFn))
		} else {
			visibleLen := visibleWidth(lineWithMargins)
			pad := width - visibleLen
			if pad < 0 {
				pad = 0
			}
			contentLines = append(contentLines, lineWithMargins+strings.Repeat(" ", pad))
		}
	}

	// Top/bottom padding.
	emptyLine := strings.Repeat(" ", width)
	var emptyLines []string
	for i := 0; i < m.paddingY; i++ {
		if bgFn != nil {
			emptyLines = append(emptyLines, applyBackgroundToLine(emptyLine, width, bgFn))
		} else {
			emptyLines = append(emptyLines, emptyLine)
		}
	}

	result := make([]string, 0, len(emptyLines)*2+len(contentLines))
	result = append(result, emptyLines...)
	result = append(result, contentLines...)
	result = append(result, emptyLines...)

	if len(result) == 0 {
		result = []string{""}
	}

	m.cachedText = m.text
	m.cachedWidth = width
	m.cachedLines = result
	m.cachedValid = true
	putSharedRender(key, result)
	return result
}

func (m *Markdown) codeBlockIndent() string {
	if m.theme.CodeBlockIndent != "" {
		return m.theme.CodeBlockIndent
	}
	return "  "
}
