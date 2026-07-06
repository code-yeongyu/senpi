package overlays

import (
	"path/filepath"
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// trust.go ports trust-selector.ts + the getProjectTrustOptions half of
// trust-manager.ts (65-95). The trust prompt lists Trust / Trust parent /
// Do-not-trust options, marks the saved decision with ✓, and returns the option's
// TrustUpdate set (which the shell applies to the ProjectTrustStore via the
// lockfile protocol).

// TrustDecision mirrors ProjectTrustDecision (boolean | null): a *bool where nil
// means "clear this entry".
type TrustDecision = *bool

// TrustStoreEntry mirrors ProjectTrustStoreEntry.
type TrustStoreEntry struct {
	Path     string
	Decision bool
}

// TrustUpdate mirrors ProjectTrustUpdate: a path and a nullable decision.
type TrustUpdate struct {
	Path     string
	Decision TrustDecision
}

// TrustOption mirrors ProjectTrustOption.
type TrustOption struct {
	Label     string
	Trusted   bool
	Updates   []TrustUpdate
	SavedPath string // "" when unset (the session-only options)
	hasSaved  bool
}

// TrustSelection mirrors TrustSelection (Pick<ProjectTrustOption,"trusted"|"updates">).
type TrustSelection struct {
	Trusted bool
	Updates []TrustUpdate
}

// TrustOptions configures the trust prompt.
type TrustOptions struct {
	CWD            string
	SavedDecision  *TrustStoreEntry
	ProjectTrusted bool
	// IncludeSessionOnly adds the "(this session only)" options.
	IncludeSessionOnly bool
}

func boolPtr(b bool) *bool { return &b }

// normalizeCwd mirrors normalizeCwd(canonicalizePath(resolvePath(cwd))). Tests
// pass absolute POSIX paths; filepath.Clean gives the canonical form here.
func normalizeCwd(cwd string) string {
	return filepath.Clean(cwd)
}

// trustParentPath mirrors getProjectTrustParentPath: dirname(cwd), or "" at root.
func trustParentPath(cwd string) string {
	p := normalizeCwd(cwd)
	parent := filepath.Dir(p)
	if parent == p {
		return ""
	}
	return parent
}

// GetProjectTrustOptions ports getProjectTrustOptions (trust-manager.ts:65-95).
func GetProjectTrustOptions(cwd string, includeSessionOnly bool) []TrustOption {
	trustPath := normalizeCwd(cwd)
	opts := []TrustOption{
		{Label: "Trust", Trusted: true, Updates: []TrustUpdate{{Path: trustPath, Decision: boolPtr(true)}}, SavedPath: trustPath, hasSaved: true},
	}
	if parent := trustParentPath(cwd); parent != "" {
		opts = append(opts, TrustOption{
			Label:   "Trust parent folder (" + parent + ")",
			Trusted: true,
			Updates: []TrustUpdate{
				{Path: parent, Decision: boolPtr(true)},
				{Path: trustPath, Decision: nil},
			},
			SavedPath: parent,
			hasSaved:  true,
		})
	}
	if includeSessionOnly {
		opts = append(opts, TrustOption{Label: "Trust (this session only)", Trusted: true})
	}
	opts = append(opts, TrustOption{
		Label:     "Do not trust",
		Trusted:   false,
		Updates:   []TrustUpdate{{Path: trustPath, Decision: boolPtr(false)}},
		SavedPath: trustPath,
		hasSaved:  true,
	})
	if includeSessionOnly {
		opts = append(opts, TrustOption{Label: "Do not trust (this session only)", Trusted: false})
	}
	return opts
}

// TrustSelector is the trust prompt overlay.
type TrustSelector struct {
	opts          TrustOptions
	options       []TrustOption
	selectedIndex int
	selection     TrustSelection
	th            *theme.Theme
}

// NewTrustSelector builds the prompt, preselecting the saved option
// (findIndex(isSavedOption), clamped to 0) — mirroring the TS constructor.
func NewTrustSelector(opts TrustOptions) *TrustSelector {
	th, _ := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	options := GetProjectTrustOptions(opts.CWD, opts.IncludeSessionOnly)
	sel := 0
	for i, o := range options {
		if isSavedOption(o, opts.SavedDecision) {
			sel = i
			break
		}
	}
	return &TrustSelector{opts: opts, options: options, selectedIndex: sel, th: th}
}

func isSavedOption(o TrustOption, saved *TrustStoreEntry) bool {
	if !o.hasSaved || saved == nil {
		return false
	}
	return saved.Decision == o.Trusted && saved.Path == o.SavedPath
}

// formatDecision mirrors formatDecision (trust-selector.ts:21-30).
func formatDecision(trustPath string, decision *TrustStoreEntry) string {
	if decision == nil {
		return "none"
	}
	label := "untrusted"
	if decision.Decision {
		label = "trusted"
	}
	if trustPath != "" && decision.Path != trustPath {
		return label + " (inherited from " + decision.Path + ")"
	}
	return label + " (" + decision.Path + ")"
}

// HandleKey feeds a key. up/down (or j/k) move; confirm selects the highlighted
// option; cancel restores the saved editor text. savedText is the editor content
// captured when the overlay opened (showExtensionCustom save/restore semantics).
func (o *TrustSelector) HandleKey(data string, kb *keybindings.Manager, savedText string) Outcome {
	switch {
	case matches(kb, data, "tui.select.up") || data == "k":
		if o.selectedIndex > 0 {
			o.selectedIndex--
		}
		return none()
	case matches(kb, data, "tui.select.down") || data == "j":
		if o.selectedIndex < len(o.options)-1 {
			o.selectedIndex++
		}
		return none()
	case matches(kb, data, "tui.select.confirm") || data == "\n":
		sel := o.options[o.selectedIndex]
		o.selection = TrustSelection{Trusted: sel.Trusted, Updates: sel.Updates}
		return selectCmd("trust", map[string]any{"trusted": sel.Trusted})
	case matches(kb, data, "tui.select.cancel"):
		return cancel(savedText)
	}
	return none()
}

// Selection returns the last confirmed selection.
func (o *TrustSelector) Selection() TrustSelection { return o.selection }

// SelectedIndex returns the highlighted option index.
func (o *TrustSelector) SelectedIndex() int { return o.selectedIndex }

// RenderPlain renders the trust prompt without color (plain text), for contract
// tests that assert content. RenderStyled adds theme styling for the QA harness.
func (o *TrustSelector) RenderPlain(width int) []string {
	return o.render(width, false)
}

// RenderStyled renders the trust prompt with grok theme styling.
func (o *TrustSelector) RenderStyled(width int) []string {
	return o.render(width, true)
}

func (o *TrustSelector) render(width int, styled bool) []string {
	fg := func(style func() lipgloss.Style, s string) string {
		if !styled {
			return s
		}
		return style().Render(s)
	}
	var savedPath string
	if len(o.options) > 0 {
		savedPath = o.options[0].SavedPath
	}
	current := "untrusted"
	if o.opts.ProjectTrusted {
		current = "trusted"
	}

	lines := []string{
		fg(o.th.AccentBlue, "Project trust"),
		fg(o.th.TextMuted, o.opts.CWD),
		"",
		fg(o.th.TextMuted, "Saved decision: "+formatDecision(savedPath, o.opts.SavedDecision)),
		fg(o.th.TextMuted, "Current session: "+current),
		"",
	}
	for i, opt := range o.options {
		isSelected := i == o.selectedIndex
		isCurrent := isSavedOption(opt, o.opts.SavedDecision)
		checkmark := ""
		if isCurrent {
			checkmark = fg(o.th.AccentGreen, " ✓")
		}
		prefix := "  "
		label := opt.Label
		if isSelected {
			prefix = fg(o.th.AccentBlue, "→ ")
			label = fg(o.th.AccentBlue, opt.Label)
		} else {
			label = fg(o.th.TextPrimary, opt.Label)
		}
		lines = append(lines, prefix+label+checkmark)
	}
	lines = append(lines, "", trustHint())
	return lines
}

func trustHint() string {
	return strings.Join([]string{"↑↓ navigate", "enter save", "esc cancel"}, "  ")
}
