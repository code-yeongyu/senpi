package builtinext

import (
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// FileDiffInfo is one changed file from git status --porcelain. Mirror of the
// FileInfo interface in diff.ts:12-16 (status == statusLabel in the classic
// impl, so a single Status field suffices).
type FileDiffInfo struct {
	Status string
	File   string
}

// ParseGitStatus mirrors diff.ts:42-62: splits porcelain output, skips lines
// shorter than 4 chars, reads the two-char XY status + filename (from column 2,
// leading whitespace trimmed), and translates the status code to a short label
// (M/A/D/?/R/C, else the trimmed raw status or "~").
func ParseGitStatus(stdout string) []FileDiffInfo {
	lines := strings.Split(stdout, "\n")
	files := make([]FileDiffInfo, 0, len(lines))
	for _, line := range lines {
		if len(line) < 4 {
			continue
		}
		status := line[:2]
		file := strings.TrimLeft(line[2:], " \t")
		files = append(files, FileDiffInfo{Status: statusLabel(status), File: file})
	}
	return files
}

// statusLabel mirrors the diff.ts status-code translation ladder.
func statusLabel(status string) string {
	switch {
	case strings.Contains(status, "M"):
		return "M"
	case strings.Contains(status, "A"):
		return "A"
	case strings.Contains(status, "D"):
		return "D"
	case strings.Contains(status, "?"):
		return "?"
	case strings.Contains(status, "R"):
		return "R"
	case strings.Contains(status, "C"):
		return "C"
	default:
		if trimmed := strings.TrimSpace(status); trimmed != "" {
			return trimmed
		}
		return "~"
	}
}

// --- diff picker overlay ----------------------------------------------------

// DiffPickerOptions configures a DiffPickerOverlay.
type DiffPickerOptions struct {
	Files         []FileDiffInfo
	Theme         *theme.Theme
	Keybindings   *keybindings.Manager
	OnOpen        func(FileDiffInfo)
	Done          func()
	RequestRender func()
}

// DiffPickerOverlay is the native port of the diff.ts SelectList picker: a
// per-status colored status column, ←→ paging, ↑↓ navigation, enter opens the
// diff, esc closes.
type DiffPickerOverlay struct {
	opts        DiffPickerOptions
	roles       roleStyler
	list        *ui.SelectList
	byIndex     map[string]FileDiffInfo
	visibleRows int
	topRule     *ui.DynamicBorder
	botRule     *ui.DynamicBorder
}

// NewDiffPickerOverlay builds the diff picker.
func NewDiffPickerOverlay(opts DiffPickerOptions) *DiffPickerOverlay {
	accent := func(s string) string { return newRoleStyler(opts.Theme).fg("accent", s) }
	ov := &DiffPickerOverlay{
		opts:    opts,
		roles:   newRoleStyler(opts.Theme),
		byIndex: map[string]FileDiffInfo{},
		topRule: ui.NewDynamicBorderColored(accent),
		botRule: ui.NewDynamicBorderColored(accent),
	}
	ov.build()
	return ov
}

func (o *DiffPickerOverlay) build() {
	r := o.roles
	items := make([]ui.SelectItem, len(o.opts.Files))
	for i, f := range o.opts.Files {
		key := itoa(i)
		o.byIndex[key] = f
		items[i] = ui.SelectItem{Value: key, Label: colorStatus(r, f.Status) + " " + f.File}
	}
	o.visibleRows = min(len(o.opts.Files), 15)
	maxVisible := o.visibleRows
	if maxVisible < 1 {
		maxVisible = 1
	}
	o.list = ui.NewSelectList(items, maxVisible, pickerListTheme(r), ui.SelectListLayout{})
}

// colorStatus mirrors the diff.ts status-color switch (diff.ts:149-165).
func colorStatus(r roleStyler, status string) string {
	switch status {
	case "M":
		return r.fg("warning", status)
	case "A":
		return r.fg("success", status)
	case "D":
		return r.fg("error", status)
	case "?":
		return r.fg("muted", status)
	default:
		return r.fg("dim", status)
	}
}

// HandleInput routes navigation + paging + confirm/cancel through the keybinding
// manager (mirror of the diff.ts custom component handleInput).
func (o *DiffPickerOverlay) HandleInput(input string) {
	if handlePickerNav(o.opts.Keybindings, o.list, o.visibleRows, input,
		func() {
			if item, ok := o.list.SelectedItem(); ok {
				o.opts.OnOpen(o.byIndex[item.Value])
			}
		},
		o.opts.Done,
	) && o.opts.RequestRender != nil {
		o.opts.RequestRender()
	}
}

// Render lays out the framed diff picker.
func (o *DiffPickerOverlay) Render(width int) []string {
	r := o.roles
	lines := []string{}
	lines = append(lines, o.topRule.Render(width)...)
	lines = append(lines, r.fg("accent", r.boldText(" Select file to diff")))
	lines = append(lines, o.list.Render(width)...)
	lines = append(lines, r.fg("dim", " ↑↓ navigate • ←→ page • enter open • esc close"))
	lines = append(lines, o.botRule.Render(width)...)
	return lines
}
