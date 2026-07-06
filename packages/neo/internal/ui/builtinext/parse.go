package builtinext

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// readDirIfExists mirrors the TS readDirIfExists helper: a missing directory
// yields an empty list with no error; any other error propagates.
func readDirIfExists(path string) ([]string, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.Name()
	}
	return names, nil
}

// nonEmptyLines splits on "\n" and drops empty lines, mirroring the TS
// `.split("\n").filter((line) => line.length > 0)`. A trailing "\r" is stripped
// so CRLF files parse identically.
func nonEmptyLines(text string) []string {
	raw := strings.Split(text, "\n")
	out := make([]string, 0, len(raw))
	for _, line := range raw {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		out = append(out, line)
	}
	return out
}

// baseNameNoExt returns the filename without its .jsonl extension, mirroring
// basename(file, ".jsonl").
func baseNameNoExt(path string) string {
	name := filepath.Base(path)
	return strings.TrimSuffix(name, ".jsonl")
}

// parseISOms parses an ISO-8601 timestamp to ms-since-epoch, mirroring
// Date.parse. An unparseable value yields ok=false (Number.isFinite check).
func parseISOms(s string) (int64, bool) {
	if s == "" {
		return 0, false
	}
	layouts := []string{
		"2006-01-02T15:04:05.000Z07:00",
		time.RFC3339Nano,
		time.RFC3339,
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixMilli(), true
		}
	}
	return 0, false
}
