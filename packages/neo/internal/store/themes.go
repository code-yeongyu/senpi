package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ThemeInfo mirrors ThemeInfo (theme.ts): a custom theme's display name (from
// the "name" field inside the file, NOT the filename) and its path on disk.
type ThemeInfo struct {
	Name string
	Path string
}

// themeFile decodes only the "name" field of a theme JSON file.
type themeFile struct {
	Name string `json:"name"`
}

// ListCustomThemes lists the user's custom themes, mirroring getCustomThemeInfos
// (theme.ts:483-506): every *.json in the themes dir is parsed and its inner
// "name" field is used; non-json, unparseable, or name-less files are skipped.
// A missing directory yields an empty list with no error. Results are sorted by
// name (theme.ts:480 sorts custom themes for a stable picker).
func ListCustomThemes(agentDir string) ([]ThemeInfo, error) {
	dir := filepath.Join(agentDir, "themes")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var themes []ThemeInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		b, readErr := os.ReadFile(path)
		if readErr != nil {
			continue
		}
		var tf themeFile
		if err := json.Unmarshal(b, &tf); err != nil {
			// Invalid theme file: ignored here (the resource loader reports it
			// during normal startup/reload), mirroring the catch in theme.ts.
			continue
		}
		if tf.Name == "" {
			continue
		}
		themes = append(themes, ThemeInfo{Name: tf.Name, Path: path})
	}

	sort.Slice(themes, func(i, j int) bool {
		return themes[i].Name < themes[j].Name
	})
	return themes, nil
}
