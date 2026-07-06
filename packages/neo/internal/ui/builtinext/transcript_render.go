package builtinext

import (
	"encoding/json"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/markdown"
)

// transcript_render.go holds the per-entry line emitters used by
// RenderTranscript (transcript.go). Split from transcript.go to keep each file
// within the pure-LOC ceiling; the render entrypoint stays with the decode/tail
// logic, the styling helpers live here. Ported from
// session-observer/transcript-entries.ts and transcript-format.ts.

func cursorGlyph(r roleStyler, selected bool) string {
	if selected {
		return r.fg("accent", "▶")
	}
	return " "
}

func contentWidth(width int) int {
	w := width - len(indent) - 4
	if w < 20 {
		return 20
	}
	return w
}

func renderThinkingEntry(lines *[]string, r roleStyler, o TranscriptRenderOptions, text string, expanded, selected bool) {
	cursor := cursorGlyph(r, selected)
	*lines = append(*lines, "")
	suffix := ""
	if !expanded && len(text) > maxThinkingCollapsed {
		suffix = r.fg("dim", " ↵")
	}
	*lines = append(*lines, cursor+" "+r.fg("dim", "💭 Thinking")+suffix)
	displayText := text
	if !expanded && len(text) > maxThinkingCollapsed {
		displayText = text[:maxThinkingCollapsed] + "..."
	}
	if !expanded {
		renderPreview(lines, r, displayText, o.Width, "dim")
		return
	}
	rendered := renderMarkdownLines(displayText, o.Width, o.Theme)
	for i, line := range rendered {
		if i >= maxExpandedLines {
			break
		}
		*lines = append(*lines, line)
	}
	if len(rendered) > maxExpandedLines {
		*lines = append(*lines, indent+r.fg("dim", "... "+itoa(len(rendered)-maxExpandedLines)+" more lines"))
	}
}

func renderTextEntry(lines *[]string, r roleStyler, o TranscriptRenderOptions, label, text string, expanded, selected bool) {
	cursor := cursorGlyph(r, selected)
	*lines = append(*lines, "")
	*lines = append(*lines, cursor+" "+r.fg("muted", label))
	if !expanded {
		renderPreview(lines, r, text, o.Width, "dim")
		return
	}
	*lines = append(*lines, renderMarkdownLines(text, o.Width, o.Theme)...)
}

func renderUserEntry(lines *[]string, r roleStyler, o TranscriptRenderOptions, label, text string, expanded, selected bool) {
	cursor := cursorGlyph(r, selected)
	*lines = append(*lines, "")
	if expanded {
		*lines = append(*lines, cursor+" "+r.fg("dim", "["+label+"]"))
		*lines = append(*lines, renderMarkdownLines(text, o.Width, o.Theme)...)
		return
	}
	normalized := compactWhitespace(text)
	*lines = append(*lines, cursor+" "+r.fg("dim", "["+label+"]")+" "+r.fg("muted", sanitizeLine(normalized, contentWidth(o.Width))))
}

func renderToolEntry(lines *[]string, r roleStyler, o TranscriptRenderOptions, call TranscriptBlock, result TranscriptMessage, expanded, selected bool) {
	cursor := cursorGlyph(r, selected)
	*lines = append(*lines, "")
	*lines = append(*lines, cursor+" "+r.fg("accent", "▸")+" "+r.boldText(r.fg("muted", call.ToolName)))
	args := formatToolArgs(call)
	if args != "" {
		*lines = append(*lines, indent+r.fg("dim", sanitizeLine(args, contentWidth(o.Width))))
	}
	renderToolResult(lines, r, o, result, expanded)
}

func renderToolResult(lines *[]string, r roleStyler, o TranscriptRenderOptions, result TranscriptMessage, expanded bool) {
	if result.Role != "toolResult" {
		return
	}
	text := toolResultText(result)
	if text == "" {
		*lines = append(*lines, indent+r.fg("success", "✓ done"))
		return
	}
	resultLines := strings.Split(text, "\n")
	maxLines := 3
	if expanded {
		maxLines = 20
	}
	color := "dim"
	marker := "✓"
	markerColor := "success"
	if result.IsError {
		color, marker, markerColor = "error", "✗", "error"
	}
	first := ""
	if len(resultLines) > 0 {
		first = resultLines[0]
	}
	*lines = append(*lines, indent+r.fg(markerColor, marker)+" "+r.fg(color, sanitizeLine(first, contentWidth(o.Width))))
	for i := 1; i < len(resultLines) && i < maxLines; i++ {
		*lines = append(*lines, indent+"  "+r.fg(color, sanitizeLine(resultLines[i], contentWidth(o.Width))))
	}
	if len(resultLines) > maxLines {
		*lines = append(*lines, indent+"  "+r.fg("dim", "... "+itoa(len(resultLines)-maxLines)+" more"))
	}
}

func renderPreview(lines *[]string, r roleStyler, text string, width int, color string) {
	textLines := strings.Split(text, "\n")
	maxWidth := contentWidth(width)
	for i := 0; i < len(textLines) && i < maxCollapsedLines; i++ {
		*lines = append(*lines, indent+r.fg(color, sanitizeLine(textLines[i], maxWidth)))
	}
	if len(textLines) > maxCollapsedLines {
		*lines = append(*lines, indent+r.fg("dim", "... "+itoa(len(textLines)-maxCollapsedLines)+" more lines"))
	}
}

// toolResultText mirrors transcript-format.ts toolResultText.
func toolResultText(result TranscriptMessage) string {
	var parts []string
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(result.Content, &blocks); err == nil {
		for _, b := range blocks {
			if b.Type == "text" {
				parts = append(parts, b.Text)
			}
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

// formatToolArgs mirrors transcript-format.ts formatToolArgs.
func formatToolArgs(call TranscriptBlock) string {
	if p, ok := stringArg(call.Arguments, "path"); ok && (call.ToolName == "read" || call.ToolName == "write" || call.ToolName == "edit") {
		return "path: " + p
	}
	if cmd, ok := stringArg(call.Arguments, "command"); ok && call.ToolName == "bash" {
		return strings.ReplaceAll(cmd, "\t", "   ")
	}
	var parts []string
	total := 0
	for key, raw := range call.Arguments {
		if strings.HasPrefix(key, "_") {
			continue
		}
		var encoded string
		var s string
		if json.Unmarshal(raw, &s) == nil {
			encoded = s
		} else {
			encoded = string(raw)
		}
		part := key + ": " + encoded
		if total+len(part) > maxToolArgsChars {
			break
		}
		parts = append(parts, part)
		total += len(part)
	}
	return strings.Join(parts, ", ")
}

// sanitizeLine mirrors text.ts sanitizeLine: tabs -> 3 spaces, drop CR, truncate
// to width with a "…" ellipsis.
func sanitizeLine(text string, width int) string {
	cleaned := strings.ReplaceAll(strings.ReplaceAll(text, "\t", "   "), "\r", "")
	if width < 1 {
		width = 1
	}
	return ui.TruncateToWidth(cleaned, width, "…")
}

// renderMarkdownLines renders markdown at the transcript content width, indented,
// mirroring transcript-format.ts renderMarkdown.
func renderMarkdownLines(text string, width int, th *theme.Theme) []string {
	w := width - len(indent) - 4
	if w < 40 {
		w = 40
	}
	md := markdown.New(text, 0, 0, markdown.GrokTheme(th), nil, nil)
	out := md.Render(w)
	result := make([]string, len(out))
	for i, line := range out {
		result[i] = indent + strings.TrimRight(line, " ")
	}
	return result
}
