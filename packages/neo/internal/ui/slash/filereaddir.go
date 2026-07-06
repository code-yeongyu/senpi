package slash

import (
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor"
)

// This file holds the readdir-based path completion (the non-@ / forced-Tab
// path), split from filewalk.go (fd fuzzy @file search) to keep each file under
// the 250-LOC ceiling.

// expandHome ports expandHomePath (autocomplete.ts:494-503).
func (p *CombinedProvider) expandHome(pathStr string) string {
	home, _ := os.UserHomeDir()
	if strings.HasPrefix(pathStr, "~/") {
		expanded := filepath.Join(home, pathStr[2:])
		if strings.HasSuffix(pathStr, "/") && !strings.HasSuffix(expanded, "/") {
			return expanded + "/"
		}
		return expanded
	}
	if pathStr == "~" {
		return home
	}
	return pathStr
}

// fileSuggestions ports getFileSuggestions (autocomplete.ts:544-677): the
// readdir-based path completion used for non-@ prefixes and forced Tab.
func (p *CombinedProvider) fileSuggestions(prefix string) []editor.Item {
	raw, isAt, isQuoted := parsePathPrefix(prefix)
	expanded := raw
	if strings.HasPrefix(expanded, "~") {
		expanded = p.expandHome(expanded)
	}

	isRoot := raw == "" || raw == "./" || raw == "../" || raw == "~" || raw == "~/" || raw == "/" || (isAt && raw == "")

	var searchDir, searchPrefix string
	switch {
	case isRoot:
		if strings.HasPrefix(raw, "~") || strings.HasPrefix(expanded, "/") {
			searchDir = expanded
		} else {
			searchDir = filepath.Join(p.basePath, expanded)
		}
		searchPrefix = ""
	case strings.HasSuffix(raw, "/"):
		if strings.HasPrefix(raw, "~") || strings.HasPrefix(expanded, "/") {
			searchDir = expanded
		} else {
			searchDir = filepath.Join(p.basePath, expanded)
		}
		searchPrefix = ""
	default:
		dir := path.Dir(expanded)
		file := path.Base(expanded)
		if strings.HasPrefix(raw, "~") || strings.HasPrefix(expanded, "/") {
			searchDir = dir
		} else {
			searchDir = filepath.Join(p.basePath, dir)
		}
		searchPrefix = file
	}

	entries, err := os.ReadDir(searchDir)
	if err != nil {
		return nil
	}

	var items []editor.Item
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(strings.ToLower(name), strings.ToLower(searchPrefix)) {
			continue
		}
		isDir := entry.IsDir()
		if !isDir && entry.Type()&os.ModeSymlink != 0 {
			if info, serr := os.Stat(filepath.Join(searchDir, name)); serr == nil {
				isDir = info.IsDir()
			}
		}

		relativePath := relativePathFor(raw, name)
		relativePath = toDisplayPath(relativePath)
		pathValue := relativePath
		if isDir {
			pathValue = relativePath + "/"
		}
		value := buildCompletionValue(pathValue, isAt, isQuoted)
		label := name
		if isDir {
			label += "/"
		}
		items = append(items, editor.Item{Value: value, Label: label})
	}

	// Directories first, then case-insensitive alphabetical by label.
	sort.SliceStable(items, func(i, j int) bool {
		ai := strings.HasSuffix(items[i].Value, "/")
		aj := strings.HasSuffix(items[j].Value, "/")
		if ai != aj {
			return ai
		}
		return strings.ToLower(items[i].Label) < strings.ToLower(items[j].Label)
	})
	return items
}

// relativePathFor ports the display-path construction inside getFileSuggestions
// (autocomplete.ts:612-647).
func relativePathFor(displayPrefix, name string) string {
	switch {
	case strings.HasSuffix(displayPrefix, "/"):
		return displayPrefix + name
	case strings.Contains(displayPrefix, "/") || strings.Contains(displayPrefix, `\`):
		if strings.HasPrefix(displayPrefix, "~/") {
			homeRel := displayPrefix[2:]
			dir := path.Dir(homeRel)
			if dir == "." {
				return "~/" + name
			}
			return "~/" + path.Join(dir, name)
		}
		if strings.HasPrefix(displayPrefix, "/") {
			dir := path.Dir(displayPrefix)
			if dir == "/" {
				return "/" + name
			}
			return dir + "/" + name
		}
		rel := path.Join(path.Dir(displayPrefix), name)
		if strings.HasPrefix(displayPrefix, "./") && !strings.HasPrefix(rel, "./") {
			return "./" + rel
		}
		return rel
	default:
		if strings.HasPrefix(displayPrefix, "~") {
			return "~/" + name
		}
		return name
	}
}
