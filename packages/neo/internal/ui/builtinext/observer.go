package builtinext

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// SessionHudEntry is the picker-sufficient summary of a session, mirroring
// session-observer/types.ts:4-14.
type SessionHudEntry struct {
	ID           string
	ShortID      string
	Path         string
	CWD          string
	CreatedAt    time.Time
	ModifiedAt   time.Time
	MessageCount int
	LastUserText string
	IsCurrent    bool
}

// TranscriptSnapshot is the loaded, message-only view of a session file plus its
// resolved model, mirroring session-observer/types.ts:16-19.
type TranscriptSnapshot struct {
	Entries []SessionMessageEntry
	Model   string
}

// SessionMessageEntry is a decoded `type:"message"` entry: its parsed message
// payload plus the raw entry for downstream rendering.
type SessionMessageEntry struct {
	Message TranscriptMessage
}

// ResolveSessionHudRoot mirrors session-observer/scanner.ts:16-28, identical in
// spirit to ResolveSearchRoot: the cross-cwd sessions root for default-subdir
// layouts, an isolated custom dir otherwise.
func ResolveSessionHudRoot(currentSessionDir, defaultSessionsRoot string) string {
	return ResolveSearchRoot(currentSessionDir, defaultSessionsRoot)
}

// ScanSessionHudEntries mirrors scanner.ts:131-147: discovers session files
// (top-level + one cwd-subdir deep), summarizes each (dropping malformed files
// without disabling the picker), and sorts by newest message activity.
func ScanSessionHudEntries(root, currentSessionFile string) ([]SessionHudEntry, error) {
	files, err := discoverHudFiles(root)
	if err != nil {
		return nil, err
	}
	var sessions []SessionHudEntry
	for _, file := range files {
		s, ok, sErr := summarizeSession(file, currentSessionFile)
		if sErr != nil {
			return nil, sErr
		}
		if ok {
			sessions = append(sessions, s)
		}
	}
	sort.SliceStable(sessions, func(i, j int) bool {
		return sessions[i].ModifiedAt.After(sessions[j].ModifiedAt)
	})
	return sessions, nil
}

// discoverHudFiles mirrors scanner.ts discoverSessionFiles.
func discoverHudFiles(root string) ([]string, error) {
	names, err := readDirIfExists(root)
	if err != nil {
		return nil, err
	}
	files, err := collectHudFilesInDir(root)
	if err != nil {
		return nil, err
	}
	for _, name := range names {
		if strings.HasSuffix(name, ".jsonl") {
			continue
		}
		dir := filepath.Join(root, name)
		info, statErr := os.Stat(dir)
		if statErr != nil {
			if os.IsNotExist(statErr) {
				continue
			}
			return nil, statErr
		}
		if !info.IsDir() {
			continue
		}
		sub, cErr := collectHudFilesInDir(dir)
		if cErr != nil {
			return nil, cErr
		}
		files = append(files, sub...)
	}
	return files, nil
}

func collectHudFilesInDir(dir string) ([]string, error) {
	names, err := readDirIfExists(dir)
	if err != nil {
		return nil, err
	}
	var files []string
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
		if info.Mode().IsRegular() {
			files = append(files, p)
		}
	}
	return files, nil
}

// summarizeSession mirrors scanner.ts:109-129 (summarizeSession + firstHeader +
// lastUserText + latestMessageTimestamp). A file whose first entry is not a
// session header still summarizes with a synthetic header (firstHeader's
// fallback), matching the classic behavior. A file with a corrupt/undecodable
// header AND no entries is dropped (ok=false).
func summarizeSession(filePath, currentSessionFile string) (SessionHudEntry, bool, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return SessionHudEntry{}, false, nil
		}
		return SessionHudEntry{}, false, err
	}
	info, statErr := os.Stat(filePath)

	entries := parseSessionEntries(string(data))
	header, ok := firstHeader(entries, filePath)
	if !ok {
		return SessionHudEntry{}, false, nil
	}
	messageCount := 0
	for _, e := range entries {
		if e.Type == "message" {
			messageCount++
		}
	}
	var mtime time.Time
	if statErr == nil && info != nil {
		mtime = info.ModTime()
	}
	shortID := header.ID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	return SessionHudEntry{
		ID:           header.ID,
		ShortID:      shortID,
		Path:         filePath,
		CWD:          header.CWD,
		CreatedAt:    parseISOTimeOrZero(header.Timestamp),
		ModifiedAt:   latestMessageTimestamp(entries, mtime),
		MessageCount: messageCount,
		LastUserText: lastUserText(entries),
		IsCurrent:    currentSessionFile != "" && currentSessionFile == filePath,
	}, true, nil
}

// rawSessionEntry is a decoded JSONL entry with its type and raw payload.
type rawSessionEntry struct {
	Type      string
	Timestamp string
	Raw       json.RawMessage
}

// scannerHeader mirrors the SessionHeader fields scanner.ts consumes.
type scannerHeader struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	CWD       string `json:"cwd"`
}

// parseSessionEntries mirrors parseSessionEntries: decodes each non-empty line,
// skipping malformed (undecodable) lines silently (the classic loader returns
// null for those). The full raw payload is retained for message decoding.
func parseSessionEntries(content string) []rawSessionEntry {
	lines := nonEmptyLines(content)
	entries := make([]rawSessionEntry, 0, len(lines))
	for _, line := range lines {
		var env struct {
			Type      string `json:"type"`
			Timestamp string `json:"timestamp"`
		}
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			continue
		}
		entries = append(entries, rawSessionEntry{Type: env.Type, Timestamp: env.Timestamp, Raw: json.RawMessage(line)})
	}
	return entries
}

// firstHeader mirrors scanner.ts:80-85: the first entry if it is a session
// header, else (when there are entries) a synthetic fallback header. An empty
// entry list yields ok=false.
func firstHeader(entries []rawSessionEntry, filePath string) (scannerHeader, bool) {
	if len(entries) == 0 {
		return scannerHeader{}, false
	}
	if entries[0].Type == "session" {
		var h scannerHeader
		if err := json.Unmarshal(entries[0].Raw, &h); err == nil && h.ID != "" {
			return h, true
		}
	}
	return scannerHeader{Type: "session", ID: baseNameNoExt(filePath), Timestamp: time.UnixMilli(0).UTC().Format(time.RFC3339Nano), CWD: ""}, true
}

// lastUserText mirrors scanner.ts:87-97.
func lastUserText(entries []rawSessionEntry) string {
	for i := len(entries) - 1; i >= 0; i-- {
		if entries[i].Type != "message" {
			continue
		}
		msg, ok := decodeTranscriptMessage(entries[i].Raw)
		if !ok || msg.Role != "user" {
			continue
		}
		text := compactWhitespace(getTextContentStr(msg.Content))
		if text != "" {
			return text
		}
	}
	return "(no user prompt)"
}

// latestMessageTimestamp mirrors scanner.ts:99-107: the newest parseable entry
// timestamp (non-session entries), else the fallback (file mtime).
func latestMessageTimestamp(entries []rawSessionEntry, fallback time.Time) time.Time {
	for i := len(entries) - 1; i >= 0; i-- {
		if entries[i].Type == "session" {
			continue
		}
		if ts, ok := parseISOms(entries[i].Timestamp); ok {
			return time.UnixMilli(ts).UTC()
		}
	}
	return fallback
}

func parseISOTimeOrZero(s string) time.Time {
	if ts, ok := parseISOms(s); ok {
		return time.UnixMilli(ts).UTC()
	}
	return time.Time{}
}

// compactWhitespace mirrors text.ts compactWhitespace.
func compactWhitespace(text string) string {
	return strings.Join(strings.FieldsFunc(text, func(r rune) bool {
		return r == '\r' || r == '\n' || r == '\t' || r == ' '
	}), " ")
}
