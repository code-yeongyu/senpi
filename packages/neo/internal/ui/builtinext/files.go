package builtinext

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// FileEntry is one file the model touched in the active branch, coalesced by
// path with the union of operations and the newest execution timestamp. Mirror
// of the FileEntry interface in files.ts:13-17.
type FileEntry struct {
	Path          string
	Operations    map[string]bool // "read" | "write" | "edit"
	LastTimestamp int64
}

var patchedPathRE = regexp.MustCompile(`(?m)^\*\*\* (?:(?:Add|Delete|Update) File|Move to): (.+)$`)

// extractPatchedPaths ports gpt-apply-patch/text.ts extractPatchedPaths: pulls
// every *** {Add|Delete|Update} File / Move to path out of an apply_patch input.
func extractPatchedPaths(patchText string) []string {
	normalized := strings.ReplaceAll(strings.ReplaceAll(patchText, "\r\n", "\n"), "\r", "\n")
	matches := patchedPathRE.FindAllStringSubmatch(normalized, -1)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		out = append(out, m[1])
	}
	return out
}

// branchToolCall mirrors the first-pass map value in files.ts:34.
type branchToolCall struct {
	paths     []string
	name      string // "read" | "write" | "edit"
	timestamp int64
}

// CollectSessionFiles mirrors files.ts:31-100: a two-pass join over the active
// branch — first collecting read/write/edit/apply_patch tool CALLS from
// assistant messages, then matching tool RESULTS to record the real execution
// timestamp — coalescing by path (union of operations, newest timestamp), sorted
// newest first. `branch` is the branch's raw JSONL message lines.
func CollectSessionFiles(branch []string) ([]FileEntry, error) {
	toolCalls := map[string]branchToolCall{}
	for _, line := range branch {
		msg, ok := decodeBranchMessage(line)
		if !ok || msg.Role != "assistant" {
			continue
		}
		for _, block := range msg.Content {
			collectToolCall(block, msg.Timestamp, toolCalls)
		}
	}

	fileMap := map[string]*FileEntry{}
	order := []string{}
	for _, line := range branch {
		msg, ok := decodeBranchMessage(line)
		if !ok || msg.Role != "toolResult" {
			continue
		}
		call, ok := toolCalls[msg.ToolCallID]
		if !ok {
			continue
		}
		for _, path := range call.paths {
			existing, seen := fileMap[path]
			if seen {
				existing.Operations[call.name] = true
				if msg.Timestamp > existing.LastTimestamp {
					existing.LastTimestamp = msg.Timestamp
				}
			} else {
				fileMap[path] = &FileEntry{
					Path:          path,
					Operations:    map[string]bool{call.name: true},
					LastTimestamp: msg.Timestamp,
				}
				order = append(order, path)
			}
		}
	}

	files := make([]FileEntry, 0, len(fileMap))
	for _, path := range order {
		files = append(files, *fileMap[path])
	}
	sort.SliceStable(files, func(i, j int) bool { return files[i].LastTimestamp > files[j].LastTimestamp })
	return files, nil
}

// branchMessage is the minimal branch message shape files.ts inspects.
type branchMessage struct {
	Role       string
	Timestamp  int64
	Content    []branchBlock
	ToolCallID string
}

type branchBlock struct {
	Type      string
	Name      string
	ID        string
	Arguments map[string]json.RawMessage
}

func decodeBranchMessage(line string) (branchMessage, bool) {
	var env struct {
		Type    string `json:"type"`
		Message struct {
			Role       string          `json:"role"`
			Timestamp  int64           `json:"timestamp"`
			ToolCallID string          `json:"toolCallId"`
			Content    json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(line), &env); err != nil || env.Type != "message" {
		return branchMessage{}, false
	}
	m := branchMessage{
		Role:       env.Message.Role,
		Timestamp:  env.Message.Timestamp,
		ToolCallID: env.Message.ToolCallID,
	}
	// content is an array of blocks for assistant messages; a string otherwise.
	if len(env.Message.Content) > 0 && env.Message.Content[0] == '[' {
		var blocks []struct {
			Type      string                     `json:"type"`
			Name      string                     `json:"name"`
			ID        string                     `json:"id"`
			Arguments map[string]json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(env.Message.Content, &blocks); err == nil {
			for _, b := range blocks {
				m.Content = append(m.Content, branchBlock{Type: b.Type, Name: b.Name, ID: b.ID, Arguments: b.Arguments})
			}
		}
	}
	return m, true
}

// collectToolCall mirrors the first-pass block handling in files.ts:41-58.
func collectToolCall(block branchBlock, timestamp int64, into map[string]branchToolCall) {
	if block.Type != "toolCall" {
		return
	}
	switch block.Name {
	case "read", "write", "edit":
		path, ok := stringArg(block.Arguments, "path")
		if ok && path != "" {
			into[block.ID] = branchToolCall{paths: []string{path}, name: block.Name, timestamp: timestamp}
		}
	case "apply_patch":
		input, ok := stringArg(block.Arguments, "input")
		if !ok {
			return
		}
		paths := extractPatchedPaths(input)
		if len(paths) > 0 {
			into[block.ID] = branchToolCall{paths: paths, name: "edit", timestamp: timestamp}
		}
	}
}

func stringArg(args map[string]json.RawMessage, key string) (string, bool) {
	raw, ok := args[key]
	if !ok {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

// --- files picker overlay ---------------------------------------------------

// FilesPickerOptions configures a FilesPickerOverlay.
type FilesPickerOptions struct {
	Files         []FileEntry
	Theme         *theme.Theme
	Keybindings   *keybindings.Manager
	OnOpen        func(FileEntry)
	Done          func()
	RequestRender func()
}

// FilesPickerOverlay is the native port of the files.ts SelectList picker: R/W/E
// operation glyphs, ←→ paging, ↑↓ navigation, enter opens, esc closes.
type FilesPickerOverlay struct {
	opts        FilesPickerOptions
	roles       roleStyler
	list        *ui.SelectList
	byIndex     map[string]FileEntry
	visibleRows int
	topRule     *ui.DynamicBorder
	botRule     *ui.DynamicBorder
}

// NewFilesPickerOverlay builds the files picker.
func NewFilesPickerOverlay(opts FilesPickerOptions) *FilesPickerOverlay {
	accent := func(s string) string { return newRoleStyler(opts.Theme).fg("accent", s) }
	ov := &FilesPickerOverlay{
		opts:    opts,
		roles:   newRoleStyler(opts.Theme),
		byIndex: map[string]FileEntry{},
		topRule: ui.NewDynamicBorderColored(accent),
		botRule: ui.NewDynamicBorderColored(accent),
	}
	ov.build()
	return ov
}

func (o *FilesPickerOverlay) build() {
	r := o.roles
	items := make([]ui.SelectItem, len(o.opts.Files))
	for i, f := range o.opts.Files {
		key := itoa(i)
		o.byIndex[key] = f
		var ops []string
		if f.Operations["read"] {
			ops = append(ops, r.fg("muted", "R"))
		}
		if f.Operations["write"] {
			ops = append(ops, r.fg("success", "W"))
		}
		if f.Operations["edit"] {
			ops = append(ops, r.fg("warning", "E"))
		}
		items[i] = ui.SelectItem{Value: key, Label: strings.Join(ops, "") + " " + f.Path}
	}
	o.visibleRows = min(len(o.opts.Files), 15)
	maxVisible := o.visibleRows
	if maxVisible < 1 {
		maxVisible = 1
	}
	o.list = ui.NewSelectList(items, maxVisible, pickerListTheme(r), ui.SelectListLayout{})
}

// HandleInput routes navigation + paging + confirm/cancel through the keybinding
// manager (mirror of the files.ts custom component handleInput).
func (o *FilesPickerOverlay) HandleInput(input string) {
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

// Render lays out the framed files picker.
func (o *FilesPickerOverlay) Render(width int) []string {
	r := o.roles
	lines := []string{}
	lines = append(lines, o.topRule.Render(width)...)
	lines = append(lines, r.fg("accent", r.boldText(" Select file to open")))
	lines = append(lines, o.list.Render(width)...)
	lines = append(lines, r.fg("dim", " ↑↓ navigate • ←→ page • enter open • esc close"))
	lines = append(lines, o.botRule.Render(width)...)
	return lines
}
