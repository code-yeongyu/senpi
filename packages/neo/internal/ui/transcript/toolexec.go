package transcript

import (
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/transcript/terminalimage"
)

// collapsedOutputLines is the number of trailing output lines shown when a tool
// result is collapsed (grok tool rows show a bounded tail; expand shows all).
const collapsedOutputLines = 10

// ToolExecution renders a single grok-style tool-execution block: the pending
// row (`┃ ◆ <Verb> <cmd> [hooks: N]`) then, once a result arrives, the result
// body (monospace output, error styling, diff for edit tools). Expansion is
// toggled via SetExpanded (app.tools.expand at the app layer). Renders are
// memoized on a bounded render signature à la render-signature.ts, so streaming
// re-renders reuse stable output. Port of tool-execution.ts.
type ToolExecution struct {
	call      ToolCall
	theme     RenderTheme
	result    *ToolResult
	expanded  bool
	hookCount int
	pending   bool
	aborted   bool

	showImages bool
	imageWidth int

	// bounded render cache.
	cachedLines []string
	cachedWidth int
	cachedSig   string
	cacheValid  bool
}

// NewToolExecution builds a tool-execution block for a call, in the pending
// state, using the given render theme.
func NewToolExecution(call ToolCall, t RenderTheme) *ToolExecution {
	return &ToolExecution{
		call:       call,
		theme:      t,
		pending:    true,
		showImages: true,
		imageWidth: 60,
	}
}

// SetHookCount sets the number of active tool hooks (rendered as `[hooks: N]`).
func (te *ToolExecution) SetHookCount(n int) {
	te.hookCount = n
	te.invalidate()
}

// MarkPending marks the tool as executing (spinner-eligible for streaming args).
func (te *ToolExecution) MarkPending() {
	te.pending = true
	te.invalidate()
}

// SetResult attaches the finalized tool result and clears the pending state.
func (te *ToolExecution) SetResult(r ToolResult) {
	te.result = &r
	te.pending = false
	te.aborted = false
	te.invalidate()
}

// Abort marks the tool as aborted: the spinner stops and the block renders an
// aborted notice with no orphan spinner frame. Mirrors stopAnimation + the
// aborted stop-reason path.
func (te *ToolExecution) Abort() {
	te.pending = false
	te.aborted = true
	te.invalidate()
}

// SetExpanded toggles collapse/expand of the result body.
func (te *ToolExecution) SetExpanded(expanded bool) {
	te.expanded = expanded
	te.invalidate()
}

// SetShowImages toggles inline image rendering.
func (te *ToolExecution) SetShowImages(show bool) {
	te.showImages = show
	te.invalidate()
}

// IsError reports whether the result is an error result.
func (te *ToolExecution) IsError() bool {
	return te.result != nil && te.result.IsError
}

// RenderSignature returns the bounded render signature keying the render cache.
func (te *ToolExecution) RenderSignature() string {
	return BoundedRenderSignature(map[string]any{
		"toolName":  te.call.Name,
		"toolID":    te.call.ID,
		"args":      te.call.Args,
		"expanded":  te.expanded,
		"hookCount": te.hookCount,
		"pending":   te.pending,
		"aborted":   te.aborted,
		"showImg":   te.showImages,
		"imgWidth":  te.imageWidth,
		"result":    te.resultSignature(),
	})
}

func (te *ToolExecution) resultSignature() any {
	if te.result == nil {
		return nil
	}
	blocks := make([]any, 0, len(te.result.Content))
	for _, c := range te.result.Content {
		blocks = append(blocks, map[string]any{"type": c.Type, "text": c.Text, "mime": c.MimeType})
	}
	return map[string]any{"isError": te.result.IsError, "content": blocks}
}

func (te *ToolExecution) invalidate() { te.cacheValid = false; te.cachedLines = nil }

// Render lays out the tool-execution block at width, using the bounded render
// cache when the signature + width are unchanged.
func (te *ToolExecution) Render(width int) []string {
	sig := te.RenderSignature()
	if te.cacheValid && te.cachedWidth == width && te.cachedSig == sig {
		out := make([]string, len(te.cachedLines))
		copy(out, te.cachedLines)
		return out
	}

	lines := te.build(width)

	te.cachedWidth = width
	te.cachedSig = sig
	te.cachedLines = append([]string(nil), lines...)
	te.cacheValid = true
	return lines
}

// build produces the tool-execution lines (uncached).
func (te *ToolExecution) build(width int) []string {
	var out []string
	out = append(out, "") // leading spacer (Spacer(1) in the TS component)
	out = append(out, te.headerRow())

	if te.aborted {
		out = append(out, te.theme.Error("Operation aborted"))
		return out
	}

	if te.result != nil {
		out = append(out, te.resultBody(width)...)
	}
	return out
}

// headerRow renders the grok tool row: `┃ ◆ <Verb> <cmd> [hooks: N]`.
func (te *ToolExecution) headerRow() string {
	guide := te.theme.ToolGuide(te.theme.GuideGlyph)
	marker := te.theme.ToolMark(te.theme.MarkerGlyph)
	title := te.theme.ToolTitle(bold(te.verb()) + " " + te.commandSummary())
	row := guide + " " + marker + " " + title
	if te.hookCount > 0 {
		row += " " + te.theme.Muted("[hooks: "+itoaSigned(te.hookCount)+"]")
	}
	return row
}

// verb maps a tool name to its grok display verb (Run for bash, otherwise the
// capitalized tool name).
func (te *ToolExecution) verb() string {
	switch te.call.Name {
	case "bash":
		return "Run"
	case "edit", "write", "apply_patch":
		return "Edit"
	case "read":
		return "Read"
	default:
		return capitalize(te.call.Name)
	}
}

// commandSummary extracts the primary argument shown on the header row
// (command for bash, path for file tools), falling back to the tool name.
func (te *ToolExecution) commandSummary() string {
	if te.call.Args == nil {
		return ""
	}
	for _, key := range []string{"command", "path", "file_path", "pattern", "query"} {
		if v, ok := te.call.Args[key]; ok {
			if s, ok := v.(string); ok && s != "" {
				return sanitizeInline(s)
			}
		}
	}
	return ""
}

// resultBody renders the tool result output (monospace text + image fallbacks),
// collapsing to a bounded tail unless expanded. Diff-style tools (edit/write/
// apply_patch) route through the diff renderer.
func (te *ToolExecution) resultBody(width int) []string {
	output := te.textOutput()
	if output == "" {
		return nil
	}

	var rendered string
	if te.isDiffTool() {
		rendered = RenderDiff(output, DiffStyles{
			Removed: te.theme.ToolDiffRemoved,
			Added:   te.theme.ToolDiffAdded,
			Context: te.theme.ToolDiffContext,
			Inverse: te.theme.Inverse,
		})
	} else {
		rendered = te.theme.ToolOutput(output)
	}

	lines := strings.Split(rendered, "\n")
	if !te.expanded && len(lines) > collapsedOutputLines {
		lines = lines[len(lines)-collapsedOutputLines:]
	}
	return lines
}

func (te *ToolExecution) isDiffTool() bool {
	switch te.call.Name {
	case "edit", "write", "apply_patch":
		return true
	}
	return false
}

// textOutput extracts the joined text output plus image-placeholder indicators,
// mirroring render-utils.getTextOutput. Images render as placeholders when the
// terminal cannot draw them or showImages is off.
func (te *ToolExecution) textOutput() string {
	if te.result == nil {
		return ""
	}
	var textParts []string
	var imageBlocks []ContentBlock
	for _, c := range te.result.Content {
		switch c.Type {
		case "text":
			textParts = append(textParts, sanitizeMultiline(c.Text))
		case "image":
			imageBlocks = append(imageBlocks, c)
		}
	}
	output := strings.Join(textParts, "\n")

	caps := terminalimage.GetCapabilities()
	if len(imageBlocks) > 0 && (caps.Images == terminalimage.ProtocolNone || !te.showImages) {
		var indicators []string
		for _, img := range imageBlocks {
			mime := img.MimeType
			if mime == "" {
				mime = "image/unknown"
			}
			indicators = append(indicators, terminalimage.ImageFallback(mime, nil, ""))
		}
		joined := strings.Join(indicators, "\n")
		if output != "" {
			output = output + "\n" + joined
		} else {
			output = joined
		}
	}
	return output
}
