package builtinext

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// itoa is the package's integer-to-string helper (used by every renderer for
// counts and indices).
func itoa(i int) string { return strconv.Itoa(i) }

// keyDisplayAliases mirrors KEY_DISPLAY_ALIASES (keybinding-hints.ts:12).
var keyDisplayAliases = map[string]string{"escape": "esc"}

// formatKeyPart mirrors keybinding-hints.ts formatKeyPart: aliases escape->esc,
// and on darwin displays alt as "option".
func formatKeyPart(part string) string {
	lower := strings.ToLower(part)
	if alias, ok := keyDisplayAliases[lower]; ok {
		return alias
	}
	if runtime.GOOS == "darwin" && lower == "alt" {
		return "option"
	}
	return part
}

// formatKeyText mirrors keybinding-hints.ts formatKeyText: "/"-joined
// alternatives, "+"-joined modifier parts, each part aliased.
func formatKeyText(key string) string {
	alts := strings.Split(key, "/")
	for i, alt := range alts {
		parts := strings.Split(alt, "+")
		for j, part := range parts {
			parts[j] = formatKeyPart(part)
		}
		alts[i] = strings.Join(parts, "+")
	}
	return strings.Join(alts, "/")
}

// keyText mirrors keybinding-hints.ts keyText: the formatted display for an
// action's bound keys.
func keyText(km *keybindings.Manager, action string) string {
	keys := km.Keys(action)
	if len(keys) == 0 {
		return ""
	}
	return formatKeyText(strings.Join(keys, "/"))
}

// keyHint mirrors keybinding-hints.ts keyHint: "<keys> <description>". The
// classic hint applies theme styling; neo keeps it plain here so the picker's
// TruncatedText width math stays exact (styling is applied by callers via the
// role stylers when needed).
func keyHint(km *keybindings.Manager, action, description string) string {
	kt := keyText(km, action)
	if kt == "" {
		return description
	}
	return kt + " " + description
}

// shortenPath mirrors utils/paths.ts shortenPath: replaces the home dir prefix
// with "~".
func shortenPath(path string) string {
	if path == "" {
		return path
	}
	home, err := os.UserHomeDir()
	if err == nil && home != "" && strings.HasPrefix(path, home) {
		return "~" + path[len(home):]
	}
	return path
}

// formatSessionDate mirrors text.ts formatSessionDate: coarse relative time
// (now / Nm / Nh / Nd / Nw / Nmo / Ny) from the given moment to now.
func formatSessionDate(t time.Time) string {
	if t.IsZero() {
		return "?"
	}
	diff := time.Since(t)
	mins := int(diff.Minutes())
	hours := int(diff.Hours())
	days := hours / 24
	switch {
	case mins < 1:
		return "now"
	case mins < 60:
		return itoa(mins) + "m"
	case hours < 24:
		return itoa(hours) + "h"
	case days < 7:
		return itoa(days) + "d"
	case days < 30:
		return itoa(days/7) + "w"
	case days < 365:
		return itoa(days/30) + "mo"
	default:
		return itoa(days/365) + "y"
	}
}

// clamp bounds v to [lo, hi].
func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
