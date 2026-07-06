package extui

import (
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor/textwidth"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// --- shared text input (grapheme-safe, single- or multi-line) ---

// textInput is a grapheme-cluster buffer with a cursor, reused by the input and
// editor dialogs. It exposes CursorCol so the app shell can place the hardware
// cursor for correct IME anchoring (task-5 contract).
type textInput struct {
	graphemes []string
	cursor    int
	multiline bool
}

func newTextInput(initial string, multiline bool) *textInput {
	in := &textInput{multiline: multiline}
	in.setValue(initial)
	return in
}

func (in *textInput) setValue(s string) {
	in.graphemes = clustersOf(s)
	in.cursor = len(in.graphemes)
}

func (in *textInput) value() string { return strings.Join(in.graphemes, "") }

func clustersOf(s string) []string {
	gs := textwidth.Graphemes(s)
	out := make([]string, 0, len(gs))
	for _, g := range gs {
		out = append(out, g.Text)
	}
	return out
}

// handleKey edits the buffer via keybinding-resolved actions. It returns
// submitted=true when a submit chord fired (enter for single-line; the multiline
// dialog treats enter as newline and ctrl+j/ctrl+s as submit via the caller).
func (in *textInput) handleKey(data string, kb *keybindings.Manager) (changed bool) {
	switch {
	case kb.Matches(data, "tui.editor.cursorLeft"):
		if in.cursor > 0 {
			in.cursor--
		}
		return false
	case kb.Matches(data, "tui.editor.cursorRight"):
		if in.cursor < len(in.graphemes) {
			in.cursor++
		}
		return false
	case kb.Matches(data, "tui.editor.cursorLineStart"):
		in.cursor = 0
		return false
	case kb.Matches(data, "tui.editor.cursorLineEnd"):
		in.cursor = len(in.graphemes)
		return false
	case kb.Matches(data, "tui.editor.deleteCharBackward"):
		if in.cursor > 0 {
			in.graphemes = append(in.graphemes[:in.cursor-1], in.graphemes[in.cursor:]...)
			in.cursor--
			return true
		}
		return false
	case kb.Matches(data, "tui.editor.deleteCharForward"):
		if in.cursor < len(in.graphemes) {
			in.graphemes = append(in.graphemes[:in.cursor], in.graphemes[in.cursor+1:]...)
			return true
		}
		return false
	}
	if isPrintableInput(data) {
		clusters := clustersOf(data)
		tail := append(clusters, in.graphemes[in.cursor:]...)
		in.graphemes = append(in.graphemes[:in.cursor:in.cursor], tail...)
		in.cursor += len(clusters)
		return true
	}
	return false
}

func isPrintableInput(data string) bool {
	if data == "" {
		return false
	}
	for _, b := range []byte(data) {
		if b == 0x1b {
			return false
		}
		if b < 0x20 && b != 0x09 && b != 0x0a {
			return false
		}
	}
	return true
}

// --- select dialog (fuzzy list over options) ---

type selectDialog struct {
	id    string
	title string
	list  *ui.SelectList
	input *textInput
	th    *theme.Theme
	kb    *keybindings.Manager
	opts  []string
	top   *ui.DynamicBorder
	bot   *ui.DynamicBorder
}

func newSelectDialog(req bridge.ExtensionUIRequest, deps Deps) *selectDialog {
	opts := fieldStrings(req.Fields, "options")
	items := make([]ui.SelectItem, len(opts))
	for i, o := range opts {
		items[i] = ui.SelectItem{Value: o, Label: o}
	}
	list := ui.NewSelectList(items, 8, listTheme(deps.Theme), ui.SelectListLayout{
		MinPrimaryColumnWidth: 12,
		MaxPrimaryColumnWidth: 40,
	})
	return &selectDialog{
		id:    req.ID,
		title: fieldString(req.Fields, "title"),
		list:  list,
		input: newTextInput("", false),
		th:    deps.Theme,
		kb:    deps.Keybindings,
		opts:  opts,
		top:   ui.NewDynamicBorder(deps.Theme),
		bot:   ui.NewDynamicBorder(deps.Theme),
	}
}

func (d *selectDialog) RequestID() string { return d.id }

func (d *selectDialog) HandleInput(data string) (Response, bool) {
	switch {
	case d.kb.Matches(data, "tui.select.up"):
		d.list.MoveUp()
		return Response{}, false
	case d.kb.Matches(data, "tui.select.down"):
		d.list.MoveDown()
		return Response{}, false
	case d.kb.Matches(data, "tui.select.cancel"):
		return Response{ID: d.id, Cancelled: true}, true
	case d.kb.Matches(data, "tui.select.confirm"):
		if it, ok := d.list.SelectedItem(); ok {
			return Response{ID: d.id, Value: it.Value}, true
		}
		return Response{ID: d.id, Cancelled: true}, true
	}
	if d.input.handleKey(data, d.kb) {
		d.list.SetFilter(d.input.value())
	}
	return Response{}, false
}

func (d *selectDialog) Render(width int) []string {
	s := newStyler(d.th)
	lines := d.top.Render(width)
	lines = append(lines, s.title("accent", d.title))
	if q := d.input.value(); q != "" {
		lines = append(lines, s.fg("dim", "› "+q))
	}
	lines = append(lines, d.list.Render(width)...)
	lines = append(lines, s.fg("dim", " ↑/↓ select · enter confirm · esc cancel"))
	lines = append(lines, d.bot.Render(width)...)
	return lines
}

// --- confirm dialog ---

type confirmDialog struct {
	id      string
	title   string
	message string
	th      *theme.Theme
	kb      *keybindings.Manager
	top     *ui.DynamicBorder
	bot     *ui.DynamicBorder
}

func newConfirmDialog(req bridge.ExtensionUIRequest, deps Deps) *confirmDialog {
	return &confirmDialog{
		id:      req.ID,
		title:   fieldString(req.Fields, "title"),
		message: fieldString(req.Fields, "message"),
		th:      deps.Theme,
		kb:      deps.Keybindings,
		top:     ui.NewDynamicBorder(deps.Theme),
		bot:     ui.NewDynamicBorder(deps.Theme),
	}
}

func (d *confirmDialog) RequestID() string { return d.id }

func (d *confirmDialog) HandleInput(data string) (Response, bool) {
	// esc/ctrl+c cancels (not confirmed); enter confirms; 'n'/'N' declines.
	if d.kb.Matches(data, "tui.select.cancel") {
		return Response{ID: d.id, Cancelled: true}, true
	}
	if d.kb.Matches(data, "tui.select.confirm") {
		yes := true
		return Response{ID: d.id, Confirmed: &yes}, true
	}
	if data == "n" || data == "N" {
		no := false
		return Response{ID: d.id, Confirmed: &no}, true
	}
	return Response{}, false
}

func (d *confirmDialog) Render(width int) []string {
	s := newStyler(d.th)
	lines := d.top.Render(width)
	lines = append(lines, s.title("accent", d.title))
	if d.message != "" {
		lines = append(lines, s.fg("text", d.message))
	}
	lines = append(lines, s.fg("dim", " enter confirm · n decline · esc cancel"))
	lines = append(lines, d.bot.Render(width)...)
	return lines
}

// --- input dialog (single-line) ---

type inputDialog struct {
	id          string
	title       string
	placeholder string
	input       *textInput
	th          *theme.Theme
	kb          *keybindings.Manager
	top         *ui.DynamicBorder
	bot         *ui.DynamicBorder
}

func newInputDialog(req bridge.ExtensionUIRequest, deps Deps) *inputDialog {
	return &inputDialog{
		id:          req.ID,
		title:       fieldString(req.Fields, "title"),
		placeholder: fieldString(req.Fields, "placeholder"),
		input:       newTextInput("", false),
		th:          deps.Theme,
		kb:          deps.Keybindings,
		top:         ui.NewDynamicBorder(deps.Theme),
		bot:         ui.NewDynamicBorder(deps.Theme),
	}
}

func (d *inputDialog) RequestID() string { return d.id }

func (d *inputDialog) HandleInput(data string) (Response, bool) {
	if d.kb.Matches(data, "tui.select.cancel") {
		return Response{ID: d.id, Cancelled: true}, true
	}
	if d.kb.Matches(data, "tui.input.submit") {
		return Response{ID: d.id, Value: d.input.value()}, true
	}
	d.input.handleKey(data, d.kb)
	return Response{}, false
}

func (d *inputDialog) Render(width int) []string {
	s := newStyler(d.th)
	lines := d.top.Render(width)
	lines = append(lines, s.title("accent", d.title))
	val := d.input.value()
	if val == "" && d.placeholder != "" {
		lines = append(lines, s.fg("dim", "› "+d.placeholder))
	} else {
		lines = append(lines, s.fg("text", "› "+val))
	}
	lines = append(lines, s.fg("dim", " enter submit · esc cancel"))
	lines = append(lines, d.bot.Render(width)...)
	return lines
}

// --- editor dialog (multiline modal) ---

type editorDialog struct {
	id    string
	title string
	input *textInput
	th    *theme.Theme
	kb    *keybindings.Manager
	top   *ui.DynamicBorder
	bot   *ui.DynamicBorder
}

func newEditorDialog(req bridge.ExtensionUIRequest, deps Deps) *editorDialog {
	return &editorDialog{
		id:    req.ID,
		title: fieldString(req.Fields, "title"),
		input: newTextInput(fieldString(req.Fields, "prefill"), true),
		th:    deps.Theme,
		kb:    deps.Keybindings,
		top:   ui.NewDynamicBorder(deps.Theme),
		bot:   ui.NewDynamicBorder(deps.Theme),
	}
}

func (d *editorDialog) RequestID() string { return d.id }

func (d *editorDialog) HandleInput(data string) (Response, bool) {
	if d.kb.Matches(data, "tui.select.cancel") {
		return Response{ID: d.id, Cancelled: true}, true
	}
	// Multiline editor: enter inserts a newline; ctrl+s / ctrl+j submits.
	if d.kb.Matches(data, "tui.input.newLine") || data == "\x13" {
		return Response{ID: d.id, Value: d.input.value()}, true
	}
	if data == "\r" || data == "\n" {
		d.input.graphemes = append(d.input.graphemes[:d.input.cursor:d.input.cursor], append([]string{"\n"}, d.input.graphemes[d.input.cursor:]...)...)
		d.input.cursor++
		return Response{}, false
	}
	d.input.handleKey(data, d.kb)
	return Response{}, false
}

func (d *editorDialog) Render(width int) []string {
	s := newStyler(d.th)
	lines := d.top.Render(width)
	lines = append(lines, s.title("accent", d.title))
	for _, line := range strings.Split(d.input.value(), "\n") {
		lines = append(lines, s.fg("text", line))
	}
	lines = append(lines, s.fg("dim", " ctrl+j submit · esc cancel"))
	lines = append(lines, d.bot.Render(width)...)
	return lines
}

// --- shared styling ---

// styler resolves the classic theme.fg(role, text) roles to the neo palette,
// mirroring the builtinext roleStyler seam so ext-UI dialogs color identically.
type styler struct {
	th *theme.Theme
}

func newStyler(th *theme.Theme) styler { return styler{th: th} }

func (s styler) roleStyle(role string) lipgloss.Style {
	switch role {
	case "accent":
		return s.th.AccentBlue()
	case "success":
		return s.th.AccentGreen()
	case "error":
		return s.th.AccentRed()
	case "warning":
		return s.th.AccentYellow()
	case "muted":
		return s.th.TextMuted()
	case "dim":
		return s.th.TextDim()
	default:
		return s.th.TextPrimary()
	}
}

func (s styler) fg(role, text string) string { return s.roleStyle(role).Render(text) }

// title renders a bold, role-colored heading in ONE style so the color and
// weight compose (mirrors theme.fg("accent", theme.bold(title))).
func (s styler) title(role, text string) string { return s.roleStyle(role).Bold(true).Render(text) }

func listTheme(th *theme.Theme) ui.SelectListTheme {
	return ui.SelectListTheme{
		SelectedText: func(s string) string { return th.AccentBlue().Render(s) },
		Description:  func(s string) string { return th.TextMuted().Render(s) },
		ScrollInfo:   func(s string) string { return th.TextMuted().Render(s) },
		NoMatch:      func(s string) string { return th.TextMuted().Render(s) },
	}
}
