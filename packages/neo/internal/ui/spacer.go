package ui

// Spacer renders N blank lines (port of packages/tui/src/components/spacer.ts).
type Spacer struct {
	lines int
}

// NewSpacer builds a Spacer emitting the given number of blank lines.
func NewSpacer(lines int) *Spacer {
	if lines < 0 {
		lines = 0
	}
	return &Spacer{lines: lines}
}

// SetLines updates the blank-line count.
func (s *Spacer) SetLines(lines int) {
	if lines < 0 {
		lines = 0
	}
	s.lines = lines
}

// Render returns `lines` empty strings; width is ignored.
func (s *Spacer) Render(_ int) []string {
	out := make([]string, s.lines)
	return out
}
