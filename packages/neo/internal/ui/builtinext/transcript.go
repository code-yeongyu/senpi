package builtinext

import (
	"encoding/json"
	"os"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
)

// Transcript rendering constants (transcript-format.ts:6-10).
const (
	maxCollapsedLines    = 3
	maxExpandedLines     = 100
	maxThinkingCollapsed = 200
	maxToolArgsChars     = 500
	indent               = "    "
)

// The TranscriptMessage / TranscriptBlock types and their decoders live in
// transcript_decode.go.

// ViewerEntryRange marks a rendered entry's line span + kind (types.ts:21-25).
type ViewerEntryRange struct {
	LineStart int
	LineCount int
	Kind      string // thinking | response | tool | user | system
}

// RenderedTranscript is the transcript render result (types.ts:27-30).
type RenderedTranscript struct {
	Lines  []string
	Ranges []ViewerEntryRange
}

// TranscriptRenderOptions mirrors types.ts:32-37.
type TranscriptRenderOptions struct {
	Width           int
	SelectedIndex   int
	ExpandedEntries map[int]bool
	Theme           *theme.Theme
}

// LoadTranscriptSnapshot mirrors loader.ts loadTranscriptSnapshot: reads the
// file, keeps message entries, and resolves the model from the first assistant
// message or a model_change entry.
func LoadTranscriptSnapshot(filePath string) (TranscriptSnapshot, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return TranscriptSnapshot{}, err
	}
	return snapshotFromContent(string(data)), nil
}

func snapshotFromContent(content string) TranscriptSnapshot {
	entries := parseSessionEntries(content)
	var messages []SessionMessageEntry
	model := ""
	for _, e := range entries {
		switch e.Type {
		case "message":
			if msg, ok := decodeTranscriptMessage(e.Raw); ok {
				messages = append(messages, SessionMessageEntry{Message: msg})
				if model == "" && msg.Role == "assistant" {
					if msg.ResponseModel != "" {
						model = msg.ResponseModel
					} else if msg.Model != "" {
						model = msg.Model
					}
				}
			}
		case "model_change":
			var mc struct {
				Provider string `json:"provider"`
				ModelID  string `json:"modelId"`
			}
			if err := json.Unmarshal(e.Raw, &mc); err == nil {
				model = mc.Provider + "/" + mc.ModelID
			}
		}
	}
	return TranscriptSnapshot{Entries: messages, Model: model}
}

// --- SessionTail: live tail of a growing session file -----------------------

// SessionTail re-reads a session file that a live session is actively appending
// to. Load() returns the current snapshot; Grew() reports whether the last Load
// observed a larger file than the previous one. A shrink (truncation/rewrite,
// e.g. compaction) resyncs cleanly and never panics.
type SessionTail struct {
	path     string
	lastSize int64
	grew     bool
}

// NewSessionTail builds a tail over the given session file path.
func NewSessionTail(path string) *SessionTail { return &SessionTail{path: path, lastSize: -1} }

// Load re-reads the file and returns the current transcript snapshot. Growth is
// detected by comparing the file size to the previous Load.
func (t *SessionTail) Load() (TranscriptSnapshot, error) {
	data, err := os.ReadFile(t.path)
	if err != nil {
		if os.IsNotExist(err) {
			// The file may not exist yet mid-creation; treat as an empty snapshot
			// rather than crashing the observer.
			t.grew = false
			return TranscriptSnapshot{}, nil
		}
		return TranscriptSnapshot{}, err
	}
	size := int64(len(data))
	t.grew = t.lastSize >= 0 && size > t.lastSize
	t.lastSize = size
	return snapshotFromContent(string(data)), nil
}

// Grew reports whether the most recent Load saw the file grow.
func (t *SessionTail) Grew() bool { return t.grew }

// --- RenderTranscript --------------------------------------------------------

// RenderTranscript mirrors transcript.ts renderTranscript: walks message
// entries, emitting user/thinking/response/tool/system/bash entries with the
// classic cursor + label styling and per-entry line ranges. toolResults are
// joined to their calls by toolCallId.
func RenderTranscript(entries []SessionMessageEntry, options TranscriptRenderOptions) RenderedTranscript {
	r := newRoleStyler(options.Theme)
	var lines []string
	var ranges []ViewerEntryRange
	toolResults := collectToolResults(entries)
	entryIndex := 0

	pushRange := func(start int, kind string) {
		ranges = append(ranges, ViewerEntryRange{LineStart: start, LineCount: len(lines) - start, Kind: kind})
	}

	for _, entry := range entries {
		msg := entry.Message
		switch msg.Role {
		case "toolResult":
			continue
		case "assistant":
			if len(msg.Blocks) == 0 && msg.ErrorMessage != "" {
				start := len(lines)
				renderTextEntry(&lines, r, options, "Error", msg.ErrorMessage, true, entryIndex == options.SelectedIndex)
				pushRange(start, "response")
				entryIndex++
			}
			for _, block := range msg.Blocks {
				start := len(lines)
				expanded := options.ExpandedEntries[entryIndex]
				selected := entryIndex == options.SelectedIndex
				switch {
				case block.Type == "thinking" && strings.TrimSpace(block.Thinking) != "":
					renderThinkingEntry(&lines, r, options, strings.TrimSpace(block.Thinking), expanded, selected)
					pushRange(start, "thinking")
				case block.Type == "text" && strings.TrimSpace(block.Text) != "":
					renderTextEntry(&lines, r, options, "Response", strings.TrimSpace(block.Text), expanded, selected)
					pushRange(start, "response")
				case block.Type == "toolCall":
					renderToolEntry(&lines, r, options, block, toolResults[block.ToolID], expanded, selected)
					pushRange(start, "tool")
				default:
					continue
				}
				entryIndex++
			}
		case "user":
			text := strings.TrimSpace(getTextContentStr(msg.Content))
			if text == "" {
				continue
			}
			start := len(lines)
			renderUserEntry(&lines, r, options, "User", text, options.ExpandedEntries[entryIndex], entryIndex == options.SelectedIndex)
			pushRange(start, "user")
			entryIndex++
		case "custom":
			text := strings.TrimSpace(getTextContentStr(msg.Content))
			if text == "" {
				continue
			}
			start := len(lines)
			renderUserEntry(&lines, r, options, msg.CustomType, text, options.ExpandedEntries[entryIndex], entryIndex == options.SelectedIndex)
			pushRange(start, "system")
			entryIndex++
		case "bashExecution":
			start := len(lines)
			renderUserEntry(&lines, r, options, "Bash", "$ "+msg.Command+"\n"+msg.Output, options.ExpandedEntries[entryIndex], entryIndex == options.SelectedIndex)
			pushRange(start, "tool")
			entryIndex++
		}
	}
	return RenderedTranscript{Lines: lines, Ranges: ranges}
}

func collectToolResults(entries []SessionMessageEntry) map[string]TranscriptMessage {
	results := map[string]TranscriptMessage{}
	for _, e := range entries {
		if e.Message.Role == "toolResult" {
			results[e.Message.ToolCallID] = e.Message
		}
	}
	return results
}

// The per-entry line emitters (cursorGlyph, contentWidth, render*, toolResultText,
// formatToolArgs, sanitizeLine, renderMarkdownLines) live in transcript_render.go.
