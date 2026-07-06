package builtinext

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// history_indexer.go holds the session-file discovery + prompt extraction for
// history search, split from history.go (which keeps the types, resolver, and
// filter) to stay within the pure-LOC ceiling. Ported from
// history-search/indexer.ts.

// systemPrefixes mirrors history-search/indexer.ts:7 — user lines starting with
// these markers are system-injected and excluded from history.
var systemPrefixes = []string{"[SYSTEM DIRECTIVE", "[system:", "[SYSTEM"}

// IndexSessions mirrors history-search/indexer.ts:160-168: discovers every
// .jsonl session file under rootDir (top-level + one level of cwd subdirs),
// newest-filename first, extracts user prompt lines newest-first per file,
// dedupes by text keeping the newest, and caps at 10,000 entries.
func IndexSessions(rootDir string) ([]HistoryEntry, error) {
	files, err := discoverHistoryFiles(rootDir)
	if err != nil {
		return nil, err
	}
	var entries []HistoryEntry
	for _, f := range files {
		entries, err = appendSessionEntries(f.path, entries)
		if err != nil {
			return nil, err
		}
		if len(entries) >= maxHistoryEntries {
			break
		}
	}
	return dedupeNewest(entries), nil
}

type discoveredFile struct {
	path     string
	baseName string
}

// discoverHistoryFiles mirrors indexer.ts discoverSessionFiles: top-level .jsonl
// files plus .jsonl files one directory deep, sorted by descending basename.
func discoverHistoryFiles(rootDir string) ([]discoveredFile, error) {
	names, err := readDirIfExists(rootDir)
	if err != nil {
		return nil, err
	}
	all, err := collectJSONLInDir(rootDir)
	if err != nil {
		return nil, err
	}
	for _, name := range names {
		if strings.HasSuffix(name, ".jsonl") {
			continue
		}
		sub := filepath.Join(rootDir, name)
		info, statErr := os.Stat(sub)
		if statErr != nil {
			if os.IsNotExist(statErr) {
				continue
			}
			return nil, statErr
		}
		if !info.IsDir() {
			continue
		}
		files, cErr := collectJSONLInDir(sub)
		if cErr != nil {
			return nil, cErr
		}
		all = append(all, files...)
	}
	sort.SliceStable(all, func(i, j int) bool {
		// Descending localeCompare-equivalent: newest filename first.
		return all[i].baseName > all[j].baseName
	})
	return all, nil
}

func collectJSONLInDir(dir string) ([]discoveredFile, error) {
	names, err := readDirIfExists(dir)
	if err != nil {
		return nil, err
	}
	var files []discoveredFile
	for _, name := range names {
		if !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		p := filepath.Join(dir, name)
		info, statErr := os.Stat(p)
		if statErr != nil {
			if os.IsNotExist(statErr) {
				continue
			}
			return nil, statErr
		}
		if !info.Mode().IsRegular() {
			continue
		}
		files = append(files, discoveredFile{path: p, baseName: name})
	}
	return files, nil
}

// sessionHeaderLite is the minimal header shape the indexer reads.
type sessionHeaderLite struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	CWD  string `json:"cwd"`
}

// appendSessionEntries mirrors indexer.ts appendSessionEntries: reads the file,
// parses the header from the first line, then walks lines from the END toward
// line 1 collecting valid user prompts (newest-first within a file).
func appendSessionEntries(sessionFile string, entries []HistoryEntry) ([]HistoryEntry, error) {
	data, err := os.ReadFile(sessionFile)
	if err != nil {
		if os.IsNotExist(err) {
			return entries, nil
		}
		return entries, err
	}
	lines := nonEmptyLines(string(data))
	if len(lines) == 0 {
		return entries, nil
	}
	header := parseHistoryHeader(lines[0], sessionFile)
	for i := len(lines) - 1; i >= 1; i-- {
		entry, ok := parseHistoryMessage(lines[i], sessionFile, header)
		if ok {
			entries = append(entries, entry)
		}
		if len(entries) >= maxHistoryEntries {
			return entries, nil
		}
	}
	return entries, nil
}

func parseHistoryHeader(line, sessionFile string) sessionHeaderLite {
	fallback := sessionHeaderLite{ID: baseNameNoExt(sessionFile), CWD: ""}
	var h sessionHeaderLite
	if err := json.Unmarshal([]byte(line), &h); err != nil {
		return fallback
	}
	if h.Type != "session" {
		return fallback
	}
	if h.ID == "" {
		h.ID = baseNameNoExt(sessionFile)
	}
	return h
}

// historyMessageEnvelope is the message-line shape the indexer decodes.
type historyMessageEnvelope struct {
	Type      string          `json:"type"`
	Timestamp *string         `json:"timestamp"`
	Message   json.RawMessage `json:"message"`
}

func parseHistoryMessage(line, sessionFile string, header sessionHeaderLite) (HistoryEntry, bool) {
	var env historyMessageEnvelope
	if err := json.Unmarshal([]byte(line), &env); err != nil {
		return HistoryEntry{}, false
	}
	if env.Type != "message" || len(env.Message) == 0 {
		return HistoryEntry{}, false
	}
	var msg struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(env.Message, &msg); err != nil || msg.Role != "user" {
		return HistoryEntry{}, false
	}
	text, ok := extractUserText(msg.Content)
	if !ok || strings.TrimSpace(text) == "" || isSystemInjectedPrompt(text) {
		return HistoryEntry{}, false
	}
	if env.Timestamp == nil {
		return HistoryEntry{}, false
	}
	ts, ok := parseISOms(*env.Timestamp)
	if !ok {
		return HistoryEntry{}, false
	}
	return HistoryEntry{Text: text, SessionID: header.ID, SessionFile: sessionFile, CWD: header.CWD, Timestamp: ts}, true
}

// extractUserText mirrors indexer.ts extractUserText: a string content is
// returned directly; an array yields the newline-joined text of its type:"text"
// parts.
func extractUserText(content json.RawMessage) (string, bool) {
	if len(content) == 0 {
		return "", false
	}
	var asString string
	if err := json.Unmarshal(content, &asString); err == nil {
		return asString, true
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(content, &parts); err != nil {
		return "", false
	}
	texts := make([]string, 0, len(parts))
	for _, p := range parts {
		if p.Type == "text" {
			texts = append(texts, p.Text)
		}
	}
	return strings.Join(texts, "\n"), true
}

func isSystemInjectedPrompt(text string) bool {
	trimmed := strings.TrimLeft(text, " \t\r\n")
	for _, prefix := range systemPrefixes {
		if strings.HasPrefix(trimmed, prefix) {
			return true
		}
	}
	return false
}

// dedupeNewest mirrors indexer.ts dedupeNewest: keeps the newest entry per text,
// sorted newest-first.
func dedupeNewest(entries []HistoryEntry) []HistoryEntry {
	newestByText := map[string]HistoryEntry{}
	order := []string{}
	for _, e := range entries {
		if existing, ok := newestByText[e.Text]; !ok {
			newestByText[e.Text] = e
			order = append(order, e.Text)
		} else if e.Timestamp > existing.Timestamp {
			newestByText[e.Text] = e
		}
	}
	out := make([]HistoryEntry, 0, len(newestByText))
	for _, text := range order {
		out = append(out, newestByText[text])
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Timestamp > out[j].Timestamp })
	return out
}
