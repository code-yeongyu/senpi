package slash

import (
	"strconv"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
)

// previewLines mirrors PREVIEW_LINES in bash-execution.ts (collapsed preview
// window).
const previewLines = 20

// BashCommand builds the RPC `bash` command (rpc-types.ts:53). excludeFromContext
// is set only for the `!!` variant so the wire object stays minimal for `!`.
func BashCommand(command string, excludeFromContext bool) bridge.Command {
	fields := map[string]any{"command": command}
	if excludeFromContext {
		fields["excludeFromContext"] = true
	}
	return bridge.Command{Type: "bash", Fields: fields}
}

// AbortBashCommand builds the RPC `abort_bash` command (rpc-types.ts:54), issued
// when the user cancels a running bash command (Esc).
func AbortBashCommand() bridge.Command {
	return bridge.Command{Type: "abort_bash"}
}

// bashStatus is the terminal state of a bash execution block.
type bashStatus int

const (
	bashRunning bashStatus = iota
	bashComplete
	bashCancelled
	bashError
)

// BashBlock is the streaming bash-output render block, a port of
// BashExecutionComponent (bash-execution.ts). It accumulates streamed output
// (with incomplete-line continuation + ANSI stripping), tracks completion
// status, and renders the grok-styled block: a `$ <command>` header in the
// bashMode color (green; dim for the !! excluded variant), the muted output
// preview framed by dynamic borders, and a status line.
type BashBlock struct {
	th          *theme.Theme
	command     string
	excluded    bool
	outputLines []string
	status      bashStatus
	exitCode    int
	expanded    bool
}

// NewBashBlock creates a running block for command. excluded marks the `!!`
// (exclude-from-context) variant, which uses the dim border/prompt color.
func NewBashBlock(command string, excluded bool, th *theme.Theme) *BashBlock {
	return &BashBlock{th: th, command: command, excluded: excluded, status: bashRunning}
}

// promptColorHex returns the hex of the header `$ ` prompt color: the bashMode
// accent (green) for `!`, dim for `!!` (bash-execution.ts:46-48 colorKey).
func (b *BashBlock) promptColorHex() string {
	if b.excluded {
		return b.th.Palette().TextDim
	}
	return b.th.AccentGreenHex()
}

// PromptColorHex exposes the prompt color hex for assertions/tests.
func (b *BashBlock) PromptColorHex() string { return b.promptColorHex() }

// HeaderPlain returns the unstyled header text `$ <command>` (tabs→spaces, CR
// stripped), matching formatCommandHeader's content (bash-execution.ts:21-29).
func (b *BashBlock) HeaderPlain() string {
	cmd := strings.ReplaceAll(strings.ReplaceAll(b.command, "\r", ""), "\t", "   ")
	return "$ " + cmd
}

// AppendOutput appends a streamed chunk, stripping ANSI + normalizing CRLF, with
// incomplete-line continuation (bash-execution.ts appendOutput:90-106): the
// first line of a new chunk continues the previous last line.
func (b *BashBlock) AppendOutput(chunk string) {
	clean := ui.StripANSI(chunk)
	clean = strings.ReplaceAll(clean, "\r\n", "\n")
	clean = strings.ReplaceAll(clean, "\r", "\n")
	newLines := strings.Split(clean, "\n")
	if len(b.outputLines) > 0 && len(newLines) > 0 {
		b.outputLines[len(b.outputLines)-1] += newLines[0]
		b.outputLines = append(b.outputLines, newLines[1:]...)
	} else {
		b.outputLines = append(b.outputLines, newLines...)
	}
}

// OutputLines returns the accumulated output lines.
func (b *BashBlock) OutputLines() []string {
	return append([]string(nil), b.outputLines...)
}

// SetComplete records the terminal status (bash-execution.ts setComplete:108-127):
// cancelled wins; a non-zero exit is an error; otherwise complete.
func (b *BashBlock) SetComplete(exitCode int, cancelled bool) {
	b.exitCode = exitCode
	switch {
	case cancelled:
		b.status = bashCancelled
	case exitCode != 0:
		b.status = bashError
	default:
		b.status = bashComplete
	}
}

// SetExpanded toggles the collapse/expand preview state (app.tools.expand).
func (b *BashBlock) SetExpanded(v bool) { b.expanded = v }

// StatusPlain returns the unstyled status suffix: "(exit N)" for a failure,
// "(cancelled)" when cancelled, else "" (bash-execution.ts:199-203). Hidden-line
// hints are omitted here (they depend on width/preview and are rendered live).
func (b *BashBlock) StatusPlain() string {
	switch b.status {
	case bashCancelled:
		return "(cancelled)"
	case bashError:
		return "(exit " + strconv.Itoa(b.exitCode) + ")"
	default:
		return ""
	}
}

// Render returns the styled block lines at truecolor for the given width: top
// border, `$ command` header, muted output preview, status/border. Colors come
// only from the theme (no approximated colors).
func (b *BashBlock) Render(width int) []string {
	if width < 4 {
		width = 4
	}
	borderStyle := b.th.AccentGreen()
	promptStyle := b.th.AccentGreen()
	if b.excluded {
		borderStyle = b.th.TextDim()
		promptStyle = b.th.TextDim()
	}

	var lines []string
	border := borderStyle.Render(strings.Repeat("─", width))
	lines = append(lines, border)

	// Header: green/dim "$ " + command text.
	header := promptStyle.Render("$ ") + b.th.TextPrimary().Render(b.headerCommand())
	lines = append(lines, header)

	// Output preview (muted), collapsed to previewLines unless expanded.
	display := b.outputLines
	if !b.expanded && len(display) > previewLines {
		display = display[len(display)-previewLines:]
	}
	for _, ol := range display {
		lines = append(lines, b.th.TextMuted().Render(ol))
	}

	// Status line.
	if s := b.StatusPlain(); s != "" {
		style := b.th.TextMuted()
		if b.status == bashError {
			style = b.th.AccentRed()
		} else if b.status == bashCancelled {
			style = b.th.AccentYellow()
		}
		lines = append(lines, style.Render(s))
	}

	lines = append(lines, border)
	return lines
}

func (b *BashBlock) headerCommand() string {
	return strings.ReplaceAll(strings.ReplaceAll(b.command, "\r", ""), "\t", "   ")
}
