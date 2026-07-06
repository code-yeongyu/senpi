package slash

import (
	"context"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor"
)

// fdEntry is a walk result: display path (dirs end with "/") + directory flag.
type fdEntry struct {
	path  string
	isDir bool
}

// toDisplayPath normalizes backslashes to forward slashes (autocomplete.ts:9-11).
func toDisplayPath(v string) string { return strings.ReplaceAll(v, `\`, "/") }

// buildFdPathQuery ports buildFdPathQuery (autocomplete.ts:17-43): a query
// containing '/' becomes a segment regex so fd matches path components across
// separators.
func buildFdPathQuery(query string) string {
	normalized := toDisplayPath(query)
	if !strings.Contains(normalized, "/") {
		return normalized
	}
	hasTrailing := strings.HasSuffix(normalized, "/")
	trimmed := strings.Trim(normalized, "/")
	if trimmed == "" {
		return normalized
	}
	const sep = `[\\/]`
	segs := []string{}
	for _, s := range strings.Split(trimmed, "/") {
		if s == "" {
			continue
		}
		segs = append(segs, regexp.QuoteMeta(s))
	}
	if len(segs) == 0 {
		return normalized
	}
	pattern := strings.Join(segs, sep)
	if hasTrailing {
		pattern += sep
	}
	return pattern
}

// walkDirectoryWithFd ports walkDirectoryWithFd (autocomplete.ts:124-217). The
// context cancels the child (SIGKILL) when a newer request supersedes this one.
func walkDirectoryWithFd(ctx context.Context, baseDir, fdPath, query string, maxResults int) []fdEntry {
	args := []string{
		"--base-directory", baseDir,
		"--max-results", itoa(maxResults),
		"--type", "f", "--type", "d",
		"--follow", "--hidden",
		"--exclude", ".git",
		"--exclude", ".git/*",
		"--exclude", ".git/**",
	}
	if strings.Contains(toDisplayPath(query), "/") {
		args = append(args, "--full-path")
	}
	if query != "" {
		args = append(args, buildFdPathQuery(query))
	}

	if ctx.Err() != nil {
		return nil
	}
	cmd := exec.CommandContext(ctx, fdPath, args...)
	out, err := cmd.Output()
	if err != nil || ctx.Err() != nil {
		return nil
	}

	var results []fdEntry
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		display := toDisplayPath(line)
		hasTrailing := strings.HasSuffix(display, "/")
		normalized := display
		if hasTrailing {
			normalized = display[:len(display)-1]
		}
		if normalized == ".git" || strings.HasPrefix(normalized, ".git/") || strings.Contains(normalized, "/.git/") {
			continue
		}
		results = append(results, fdEntry{path: display, isDir: hasTrailing})
	}
	return results
}

// scoreEntry ports scoreEntry (autocomplete.ts:681-701).
func scoreEntry(filePath, query string, isDir bool) int {
	fileName := path.Base(filePath)
	lf := strings.ToLower(fileName)
	lq := strings.ToLower(query)
	score := 0
	switch {
	case lf == lq:
		score = 100
	case strings.HasPrefix(lf, lq):
		score = 80
	case strings.Contains(lf, lq):
		score = 50
	case strings.Contains(strings.ToLower(filePath), lq):
		score = 30
	}
	if isDir && score > 0 {
		score += 10
	}
	return score
}

// resolveScopedFuzzyQuery ports resolveScopedFuzzyQuery (autocomplete.ts:505-533).
func (p *CombinedProvider) resolveScopedFuzzyQuery(rawQuery string) (baseDir, query, displayBase string, ok bool) {
	normalized := toDisplayPath(rawQuery)
	slash := strings.LastIndex(normalized, "/")
	if slash == -1 {
		return "", "", "", false
	}
	displayBase = normalized[:slash+1]
	query = normalized[slash+1:]
	switch {
	case strings.HasPrefix(displayBase, "~/"):
		baseDir = p.expandHome(displayBase)
	case strings.HasPrefix(displayBase, "/"):
		baseDir = displayBase
	default:
		baseDir = filepath.Join(p.basePath, displayBase)
	}
	info, err := os.Stat(baseDir)
	if err != nil || !info.IsDir() {
		return "", "", "", false
	}
	return baseDir, query, displayBase, true
}

func (p *CombinedProvider) scopedPathForDisplay(displayBase, relativePath string) string {
	rel := toDisplayPath(relativePath)
	if displayBase == "/" {
		return "/" + rel
	}
	return toDisplayPath(displayBase) + rel
}

// fuzzyFileSuggestions ports getFuzzyFileSuggestions (autocomplete.ts:704-756).
func (p *CombinedProvider) fuzzyFileSuggestions(ctx context.Context, query string, isQuoted bool) []editor.Item {
	if p.fdPath == "" || ctx.Err() != nil {
		return nil
	}
	baseDir := p.basePath
	fdQuery := query
	var scopedBase string
	scoped := false
	if b, q, db, ok := p.resolveScopedFuzzyQuery(query); ok {
		baseDir, fdQuery, scopedBase = b, q, db
		scoped = true
	}

	entries := walkDirectoryWithFd(ctx, baseDir, p.fdPath, fdQuery, 100)
	if ctx.Err() != nil {
		return nil
	}

	type scored struct {
		entry fdEntry
		score int
	}
	var scoredEntries []scored
	for _, e := range entries {
		s := 1
		if fdQuery != "" {
			s = scoreEntry(e.path, fdQuery, e.isDir)
		}
		if s > 0 {
			scoredEntries = append(scoredEntries, scored{entry: e, score: s})
		}
	}
	sort.SliceStable(scoredEntries, func(i, j int) bool { return scoredEntries[i].score > scoredEntries[j].score })
	if len(scoredEntries) > 20 {
		scoredEntries = scoredEntries[:20]
	}

	var items []editor.Item
	for _, se := range scoredEntries {
		e := se.entry
		pathWithoutSlash := e.path
		if e.isDir {
			pathWithoutSlash = e.path[:len(e.path)-1]
		}
		displayPath := pathWithoutSlash
		if scoped {
			displayPath = p.scopedPathForDisplay(scopedBase, pathWithoutSlash)
		}
		entryName := path.Base(pathWithoutSlash)
		completionPath := displayPath
		if e.isDir {
			completionPath = displayPath + "/"
		}
		value := buildCompletionValue(completionPath, true, isQuoted)
		label := entryName
		if e.isDir {
			label += "/"
		}
		items = append(items, editor.Item{Value: value, Label: label, Description: displayPath})
	}
	return items
}
