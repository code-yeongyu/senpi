package ui

// Renderable is the minimal contract a Box child must satisfy: produce lines for
// a given content width. All neo primitives (TruncatedText, Spacer,
// DynamicBorder, SelectList, SettingsList) implement it.
type Renderable interface {
	Render(width int) []string
}

// Box is a container that renders its children at a reduced content width,
// applies symmetric horizontal + vertical padding, and pads every emitted line
// to the full render width. Port of packages/tui/src/components/box.ts. An
// optional bgFn colors each full-width line (e.g. a panel surface).
type Box struct {
	paddingX int
	paddingY int
	bgFn     func(string) string
	children []Renderable
}

// NewBox builds a Box with the given padding.
func NewBox(paddingX, paddingY int) *Box {
	return &Box{paddingX: paddingX, paddingY: paddingY}
}

// SetBgFn sets an optional background colorizer applied to every full-width line.
func (b *Box) SetBgFn(fn func(string) string) { b.bgFn = fn }

// AddChild appends a child component.
func (b *Box) AddChild(c Renderable) { b.children = append(b.children, c) }

// Clear removes all children.
func (b *Box) Clear() { b.children = nil }

// Render lays out children within the box padding and returns full-width lines.
// An empty box (no children, or children that produce no lines) renders nothing,
// matching the TS Box.
func (b *Box) Render(width int) []string {
	if len(b.children) == 0 {
		return nil
	}

	contentWidth := width - b.paddingX*2
	if contentWidth < 1 {
		contentWidth = 1
	}
	leftPad := spaces(b.paddingX)

	var childLines []string
	for _, child := range b.children {
		for _, line := range child.Render(contentWidth) {
			childLines = append(childLines, leftPad+line)
		}
	}
	if len(childLines) == 0 {
		return nil
	}

	result := make([]string, 0, len(childLines)+2*b.paddingY)
	for i := 0; i < b.paddingY; i++ {
		result = append(result, b.applyBg("", width))
	}
	for _, line := range childLines {
		result = append(result, b.applyBg(line, width))
	}
	for i := 0; i < b.paddingY; i++ {
		result = append(result, b.applyBg("", width))
	}
	return result
}

// applyBg pads a line to width and optionally colors it.
func (b *Box) applyBg(line string, width int) string {
	padded := PadToWidth(line, width)
	if b.bgFn != nil {
		return b.bgFn(padded)
	}
	return padded
}
