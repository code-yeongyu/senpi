package editor

// acPopup is the inline autocomplete suggestion list. It renders each item's
// label with a selection marker and scrolls to keep the selection visible. It
// is a minimal port of the select-list behavior the editor needs; the richer
// grok-styled SelectList lands with the primitives task and can replace this.
type acPopup struct {
	items      []Item
	selected   int
	maxVisible int
	scrollOff  int
}

func newACPopup(items []Item, maxVisible int) *acPopup {
	if maxVisible < 1 {
		maxVisible = 1
	}
	return &acPopup{items: items, selected: 0, maxVisible: maxVisible}
}

func (p *acPopup) setSelected(i int) {
	if i >= 0 && i < len(p.items) {
		p.selected = i
		p.ensureVisible()
	}
}

func (p *acPopup) selectedItem() (Item, bool) {
	if p.selected < 0 || p.selected >= len(p.items) {
		return Item{}, false
	}
	return p.items[p.selected], true
}

func (p *acPopup) handleInput(data string, kb Keymap) {
	switch {
	case kb.Matches(data, ActSelectUp):
		if p.selected > 0 {
			p.selected--
		}
	case kb.Matches(data, ActSelectDown):
		if p.selected < len(p.items)-1 {
			p.selected++
		}
	}
	p.ensureVisible()
}

func (p *acPopup) ensureVisible() {
	if p.selected < p.scrollOff {
		p.scrollOff = p.selected
	} else if p.selected >= p.scrollOff+p.maxVisible {
		p.scrollOff = p.selected - p.maxVisible + 1
	}
	if p.scrollOff < 0 {
		p.scrollOff = 0
	}
}

// render returns the popup rows. Each visible item shows its label prefixed by a
// selection marker ("> " for the highlighted row, "  " otherwise).
func (p *acPopup) render(width int) []string {
	if len(p.items) == 0 {
		return nil
	}
	end := p.scrollOff + p.maxVisible
	if end > len(p.items) {
		end = len(p.items)
	}
	var out []string
	for i := p.scrollOff; i < end; i++ {
		marker := "  "
		if i == p.selected {
			marker = "> "
		}
		label := p.items[i].Label
		if label == "" {
			label = p.items[i].Value
		}
		out = append(out, truncateToWidth(marker+label, width))
	}
	return out
}
