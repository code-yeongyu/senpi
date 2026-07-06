package store

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// SessionInfo is the picker-sufficient view of a session file, mirroring the
// fields SessionInfo (session-manager.ts:193-207) that the classic picker
// consumes: id/name/first-user-message/mtime/count plus cwd and creation time.
type SessionInfo struct {
	// Path is the absolute path to the .jsonl session file.
	Path string
	// ID is the session id from the header.
	ID string
	// CWD is the working directory recorded in the header ("" for old sessions).
	CWD string
	// Name is the latest user-defined display name from session_info entries.
	Name string
	// ParentSessionPath is the parent session path when forked.
	ParentSessionPath string
	// Created is the header timestamp.
	Created time.Time
	// Modified is the last message activity time, else the header timestamp,
	// else the file mtime (mirrors buildSessionInfo's modified computation).
	Modified time.Time
	// MessageCount counts type:"message" entries.
	MessageCount int
	// FirstMessage is the first user message's text, or "(no messages)".
	FirstMessage string
}

// SessionHeader mirrors SessionHeader (session-manager.ts:55-62): the first
// line of every session file.
type SessionHeader struct {
	Type          string `json:"type"`
	Version       *int   `json:"version,omitempty"`
	ID            string `json:"id"`
	Timestamp     string `json:"timestamp"`
	CWD           string `json:"cwd"`
	ParentSession string `json:"parentSession,omitempty"`
}

// cwdSanitizer mirrors the /[/\\:]/g replacement in getDefaultSessionDirPath.
var cwdSanitizer = regexp.MustCompile(`[/\\:]`)

// leadingSlash mirrors the /^[/\\]/ leading-separator strip.
var leadingSlash = regexp.MustCompile(`^[/\\]`)

// SessionDirNameForCwd encodes a cwd into its safe sessions subdirectory name,
// byte-exact to getDefaultSessionDirPath (session-manager.ts:484-489):
// --<resolvedCwd, leading separator stripped, /\: replaced with ->--.
func SessionDirNameForCwd(cwd string) string {
	resolved := resolvePath(cwd)
	stripped := leadingSlash.ReplaceAllString(resolved, "")
	safe := cwdSanitizer.ReplaceAllString(stripped, "-")
	return "--" + safe + "--"
}

// SessionDirForCwd returns the absolute sessions directory for a cwd under an
// agent dir.
func SessionDirForCwd(agentDir, cwd string) string {
	return filepath.Join(agentDir, "sessions", SessionDirNameForCwd(cwd))
}

// ScanSessions lists picker info for every session file in the cwd's sessions
// directory. A missing directory yields an empty slice with no error (mirrors
// listSessionsFromDir's !existsSync -> [] branch, session-manager.ts:799-801),
// which is the clean-defaults failure path.
func ScanSessions(agentDir, cwd string) ([]SessionInfo, error) {
	return ScanSessionsWithWarn(agentDir, cwd, nil)
}

// ScanSessionsWithWarn is ScanSessions with a warning sink invoked once per
// skipped corrupt JSONL line (never fatal).
func ScanSessionsWithWarn(agentDir, cwd string, warn func(msg string)) ([]SessionInfo, error) {
	dir := SessionDirForCwd(agentDir, cwd)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var sessions []SessionInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		info, ok := buildSessionInfo(path, warn)
		if ok {
			sessions = append(sessions, info)
		}
	}
	return sessions, nil
}

// sessionEntry is the minimal decoded shape needed for the picker: type, the
// entry-level timestamp (the activity fallback), the session_info name, and the
// message payload. Timestamp mirrors SessionEntryBase.timestamp
// (session-manager.ts:72): an ISO-8601 string present on every non-header entry.
type sessionEntry struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp,omitempty"`
	Name      string          `json:"name,omitempty"`
	Message   json.RawMessage `json:"message,omitempty"`
}

// sessionMessage mirrors the message payload: role + content (string or an
// array of typed blocks) + optional numeric timestamp.
type sessionMessage struct {
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"`
	Timestamp *float64        `json:"timestamp,omitempty"`
}

// sessionAccumulator folds a session file's entries into picker fields,
// mirroring the running state in buildSessionInfo (session-manager.ts:668-742).
type sessionAccumulator struct {
	header       *SessionHeader
	messageCount int
	firstMessage string
	name         string
	lastActivity float64
	haveActivity bool
	invalid      bool // first valid entry was not a header -> not a pi session
}

// feed processes one already-validated (non-corrupt) entry line. It returns
// abort=true when the first entry is not a session header, matching the
// classic loader dropping such files.
func (acc *sessionAccumulator) feed(line string, typed sessionEntry) (abort bool) {
	if acc.header == nil {
		if typed.Type != "session" {
			acc.invalid = true
			return true
		}
		var h SessionHeader
		if err := json.Unmarshal([]byte(line), &h); err != nil || h.ID == "" {
			acc.invalid = true
			return true
		}
		acc.header = &h
		return false
	}

	switch typed.Type {
	case "session_info":
		acc.name = strings.TrimSpace(typed.Name)
		return false
	case "message":
		acc.feedMessage(typed.Message, typed.Timestamp)
		return false
	default:
		return false
	}
}

// feedMessage counts a message entry and updates activity time + first user
// message, mirroring the message branch of buildSessionInfo. entryTS is the
// entry-level SessionEntryBase.timestamp used as the activity fallback when the
// message has no numeric timestamp (session-manager.ts:664).
func (acc *sessionAccumulator) feedMessage(raw json.RawMessage, entryTS string) {
	acc.messageCount++
	msg, ok := decodeMessage(raw)
	if !ok {
		return
	}
	if act, ok := messageActivityTime(msg, entryTS); ok {
		if !acc.haveActivity || act > acc.lastActivity {
			acc.lastActivity = act
			acc.haveActivity = true
		}
	}
	if msg.Role != "user" && msg.Role != "assistant" {
		return
	}
	text := extractTextContent(msg.Content)
	if text == "" {
		return
	}
	if acc.firstMessage == "" && msg.Role == "user" {
		acc.firstMessage = text
	}
}

// buildSessionInfo parses one session file into picker info, mirroring
// buildSessionInfo (session-manager.ts:668-742). Corrupt lines are skipped via
// warn (parseSessionEntryLine returns null there); a file whose first entry is
// not a valid session header is dropped (returns ok=false).
func buildSessionInfo(path string, warn func(msg string)) (SessionInfo, bool) {
	f, err := os.Open(path)
	if err != nil {
		return SessionInfo{}, false
	}
	defer func() {
		// Close error on a read-only handle is non-actionable; capture then
		// discard so errcheck's check-blank sees a variable, not a bare call.
		cerr := f.Close()
		_ = cerr
	}()

	stat, statErr := f.Stat()

	// Read line-by-line with an unbounded buffer: real session files carry
	// base64 image lines several MB long, so a fixed-size bufio.Scanner would
	// truncate mid-file. bufio.Reader.ReadString grows as needed, mirroring the
	// classic loader's accumulate-across-reads scheme (session-manager.ts:
	// 514-556), which never caps line length.
	reader := bufio.NewReaderSize(f, 64*1024)
	acc := &sessionAccumulator{}

	lineNo := 0
	for {
		line, readErr := reader.ReadString('\n')
		if line != "" {
			lineNo++
			trimmed := strings.TrimRight(line, "\r\n")
			if strings.TrimSpace(trimmed) != "" {
				typed, ok := decodeSessionLine(trimmed)
				if !ok {
					// Corrupt line: skip with a warning, never fatal (mirrors
					// parseSessionEntryLine returning null on JSON.parse failure).
					if warn != nil {
						warn(fmt.Sprintf("%s:%d: skipping malformed JSONL line", path, lineNo))
					}
				} else if acc.feed(trimmed, typed) {
					return SessionInfo{}, false
				}
			}
		}
		if readErr != nil {
			break
		}
	}

	if acc.header == nil || acc.invalid {
		return SessionInfo{}, false
	}

	firstMessage := acc.firstMessage
	if firstMessage == "" {
		firstMessage = "(no messages)"
	}

	return SessionInfo{
		Path:              path,
		ID:                acc.header.ID,
		CWD:               acc.header.CWD,
		Name:              acc.name,
		ParentSessionPath: acc.header.ParentSession,
		Created:           parseISOTime(acc.header.Timestamp),
		Modified:          computeModified(acc.lastActivity, acc.haveActivity, acc.header.Timestamp, stat, statErr),
		MessageCount:      acc.messageCount,
		FirstMessage:      firstMessage,
	}, true
}

// decodeSessionLine parses a JSONL line's type/name/message envelope. A JSON
// error means a corrupt line (ok=false).
func decodeSessionLine(line string) (sessionEntry, bool) {
	var e sessionEntry
	if err := json.Unmarshal([]byte(line), &e); err != nil {
		return sessionEntry{}, false
	}
	return e, true
}

func decodeMessage(raw json.RawMessage) (sessionMessage, bool) {
	if len(raw) == 0 {
		return sessionMessage{}, false
	}
	var m sessionMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return sessionMessage{}, false
	}
	if m.Role == "" {
		return sessionMessage{}, false
	}
	return m, true
}

// extractTextContent mirrors extractTextContent (session-manager.ts:643-652):
// a string content is returned directly; an array yields the space-joined text
// of its type:"text" blocks.
func extractTextContent(content json.RawMessage) string {
	if len(content) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(content, &asString); err == nil {
		return asString
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(content, &blocks); err != nil {
		return ""
	}
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		if b.Type == "text" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, " ")
}

// messageActivityTime mirrors getMessageActivityTime (session-manager.ts:
// 654-666): only user/assistant messages contribute. A numeric message.timestamp
// (ms) wins; otherwise the entry-level timestamp is parsed as the activity
// fallback (`new Date(entry.timestamp).getTime()`, line 664) — an unparseable
// entry timestamp yields (0,false), mirroring Number.isNaN(t) ? undefined.
func messageActivityTime(msg sessionMessage, entryTS string) (float64, bool) {
	if msg.Role != "user" && msg.Role != "assistant" {
		return 0, false
	}
	if msg.Timestamp != nil {
		return *msg.Timestamp, true
	}
	t := parseISOTime(entryTS)
	if t.IsZero() {
		return 0, false
	}
	return float64(t.UnixMilli()), true
}

// computeModified mirrors buildSessionInfo's modified selection: last activity
// time (ms) if > 0, else the header timestamp, else the file mtime.
func computeModified(lastActivity float64, haveActivity bool, headerTS string, stat os.FileInfo, statErr error) time.Time {
	if haveActivity && lastActivity > 0 {
		return msToTime(lastActivity)
	}
	if t := parseISOTime(headerTS); !t.IsZero() {
		return t
	}
	if statErr == nil && stat != nil {
		return stat.ModTime()
	}
	return time.Time{}
}

func msToTime(ms float64) time.Time {
	sec := int64(ms) / 1000
	nsec := (int64(ms) % 1000) * int64(time.Millisecond)
	return time.Unix(sec, nsec).UTC()
}

// parseISOTime parses an ISO-8601 timestamp; an unparseable value yields the
// zero time (mirrors new Date(x).getTime() being NaN -> fallback).
func parseISOTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC()
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC()
	}
	return time.Time{}
}
