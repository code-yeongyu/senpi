package shell

import (
	"path/filepath"
	"sort"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
)

// FooterData is the snapshot the footer renders. It is assembled by the app
// Model from get_state + get_session_stats (bridge.RPCSessionState +
// bridge.SessionStats) so the footer stays a pure presentational component. The
// token/cost/context numbers mirror the aggregation FooterComponent.render does
// over the session entries in coding-agent footer.ts.
type FooterData struct {
	// Left HUD.
	Cwd         string // absolute cwd
	Home        string // $HOME for the ~ relativization
	GitBranch   string // current git branch, empty if none
	SessionName string // named-session label, empty if unnamed

	TokensInput  int
	TokensOutput int
	CacheRead    int
	CacheWrite   int
	// CacheHitRate is the latest assistant cache-hit percentage (0..100). Shown
	// only when there is cache activity.
	CacheHitRate    float64
	HasCacheHitRate bool

	Cost              float64
	UsingSubscription bool // appends " (sub)" and shows cost even at 0

	ContextTokens int
	ContextWindow int
	// ContextPct is the context-window usage percent. ContextPctKnown=false maps
	// to the "?" display (post-compaction, tokens unknown until next response).
	ContextPct      float64
	ContextPctKnown bool
	AutoCompact     bool

	// Right side.
	ModelID       string
	ModelReasons  bool
	ThinkingLevel string // "off"/"minimal"/… — only used when ModelReasons
	Provider      string
	ProviderCount int // >1 → prefix "(provider) " when it fits
}

// Footer renders the two-part input footer: the left token/context HUD and the
// right model:thinking label, plus an optional second line of extension
// statuses. Port of coding-agent modes/interactive/components/footer.ts.
type Footer struct {
	th        *theme.Theme
	data      FooterData
	extStatus map[string]string
}

// NewFooter builds a footer bound to a theme.
func NewFooter(th *theme.Theme) *Footer { return &Footer{th: th} }

// SetData replaces the footer snapshot.
func (f *Footer) SetData(d FooterData) { f.data = d }

// SetExtensionStatuses replaces the keyed extension-status map rendered on the
// second footer line (sorted by key).
func (f *Footer) SetExtensionStatuses(m map[string]string) { f.extStatus = m }

// formatCwdForFooter relativizes cwd to ~ when inside home, mirroring
// footer.ts formatCwdForFooter.
func formatCwdForFooter(cwd, home string) string {
	if home == "" {
		return cwd
	}
	rc := filepath.Clean(cwd)
	rh := filepath.Clean(home)
	rel, err := filepath.Rel(rh, rc)
	if err != nil {
		return cwd
	}
	inside := rel == "" || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
	if !inside {
		return cwd
	}
	if rel == "." {
		return "~"
	}
	return "~" + string(filepath.Separator) + rel
}

// Render returns the footer lines for the given width. Line 0 is the HUD; line 1
// (when present) is the sorted extension-status line. Neither line exceeds width.
func (f *Footer) Render(width int) []string {
	d := f.data
	th := f.th

	sepColored := th.TextMuted().Render(" • ")

	pwd := formatCwdForFooter(d.Cwd, d.Home)

	// Build the plain + colored left segments in footer.ts order.
	var plain []string
	var colored []string
	add := func(text string, style func(string) string) {
		plain = append(plain, text)
		colored = append(colored, style(text))
	}

	add(pwd, func(s string) string { return th.AccentBlue().Render(s) })
	if d.GitBranch != "" {
		add(d.GitBranch, func(s string) string { return th.AccentYellow().Render(s) })
	}
	if d.SessionName != "" {
		add(d.SessionName, func(s string) string { return th.TextMuted().Render(s) })
	}
	if d.TokensInput != 0 {
		add("↑"+formatTokens(d.TokensInput), func(s string) string { return th.TextDim().Render(s) })
	}
	if d.TokensOutput != 0 {
		add("↓"+formatTokens(d.TokensOutput), func(s string) string { return th.TextDim().Render(s) })
	}
	if d.CacheRead != 0 || d.CacheWrite != 0 {
		add("cache "+formatTokens(d.CacheRead)+"/"+formatTokens(d.CacheWrite), func(s string) string { return th.TextDim().Render(s) })
		if d.HasCacheHitRate {
			add("CH"+formatPct(d.CacheHitRate)+"%", func(s string) string { return th.TextDim().Render(s) })
		}
	}
	if d.Cost != 0 || d.UsingSubscription {
		cost := "$" + formatCost(d.Cost)
		if d.UsingSubscription {
			cost += " (sub)"
		}
		add(cost, func(s string) string { return th.AccentGreen().Render(s) })
	}

	// Context segment — colored by threshold (footer.ts: >90 error, >70 warning).
	auto := ""
	if d.AutoCompact {
		auto = " (auto)"
	}
	ctxTokens := formatTokens(d.ContextTokens)
	ctxWindow := formatTokens(d.ContextWindow)
	var ctxDisplay string
	if !d.ContextPctKnown {
		ctxDisplay = ctxTokens + "/" + ctxWindow + " (?)" + auto
	} else {
		ctxDisplay = ctxTokens + "/" + ctxWindow + " (" + formatPct(d.ContextPct) + "%)" + auto
	}
	ctxStyle := th.TextMuted()
	switch {
	case d.ContextPct > 90:
		ctxStyle = th.AccentRed()
	case d.ContextPct > 70:
		ctxStyle = th.AccentYellow()
	}
	plain = append(plain, ctxDisplay)
	colored = append(colored, ctxStyle.Render(ctxDisplay))

	statsLeftPlain := strings.Join(plain, " • ")
	statsLeft := strings.Join(colored, sepColored)
	statsLeftWidth := ui.VisibleWidth(statsLeftPlain)

	// Truncate the whole left HUD if it overflows (footer.ts recolors the
	// truncated plain string muted).
	if statsLeftWidth > width {
		truncated := ui.TruncateToWidth(statsLeftPlain, width, "...")
		statsLeft = th.TextMuted().Render(truncated)
		statsLeftWidth = ui.VisibleWidth(ui.StripANSI(statsLeft))
	}

	const minPadding = 2

	// Right side: (provider) model:thinking.
	modelName := d.ModelID
	if modelName == "" {
		modelName = "no-model"
	}
	rightNoProvider := modelName
	if d.ModelReasons {
		lvl := d.ThinkingLevel
		if lvl == "" {
			lvl = "off"
		}
		rightNoProvider = modelName + ":" + lvl
	}
	rightPlain := rightNoProvider
	if d.ProviderCount > 1 && d.Provider != "" {
		withProvider := "(" + d.Provider + ") " + rightNoProvider
		if statsLeftWidth+minPadding+ui.VisibleWidth(withProvider) <= width {
			rightPlain = withProvider
		}
	}

	rightWidth := ui.VisibleWidth(rightPlain)
	rightRendered := rightPlain
	actualRight := rightWidth
	if statsLeftWidth+minPadding+rightWidth > width {
		avail := width - statsLeftWidth - minPadding
		if avail > 0 {
			rightRendered = ui.TruncateToWidth(rightPlain, avail, "")
			actualRight = ui.VisibleWidth(rightRendered)
		} else {
			rightRendered = ""
			actualRight = 0
		}
	}
	coloredRight := f.colorRightSide(rightRendered)

	padCount := width - statsLeftWidth - actualRight
	if padCount < 0 {
		padCount = 0
	}
	line0 := statsLeft + spacesN(padCount) + coloredRight

	lines := []string{line0}

	// Extension statuses on a second line, sorted by key.
	if len(f.extStatus) > 0 {
		keys := make([]string, 0, len(f.extStatus))
		for k := range f.extStatus {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, k := range keys {
			parts = append(parts, sanitizeStatusText(f.extStatus[k]))
		}
		statusLine := strings.Join(parts, " ")
		lines = append(lines, ui.TruncateToWidth(statusLine, width, th.TextDim().Render("...")))
	}
	return lines
}

// colorRightSide colors the right label: (provider) muted, model accent,
// :thinking dim. Mirrors footer.ts colorRightSide (operates on the plain,
// possibly-truncated right segment).
func (f *Footer) colorRightSide(text string) string {
	if text == "" {
		return ""
	}
	th := f.th
	body := text
	providerPrefix := ""
	if strings.HasPrefix(text, "(") {
		if close := strings.Index(text, ") "); close > 0 {
			providerPrefix = th.TextMuted().Render(text[:close+2])
			body = text[close+2:]
		}
	}
	// split model:thinking on the LAST colon.
	if idx := strings.LastIndex(body, ":"); idx >= 0 {
		model := body[:idx]
		thinking := body[idx:]
		return providerPrefix + th.AccentBlue().Render(model) + th.TextDim().Render(thinking)
	}
	return providerPrefix + th.AccentBlue().Render(body)
}

// sanitizeStatusText collapses control chars/whitespace runs, mirroring
// footer.ts sanitizeStatusText.
func sanitizeStatusText(s string) string {
	var b strings.Builder
	prevSpace := false
	for _, r := range s {
		if r == '\r' || r == '\n' || r == '\t' {
			r = ' '
		}
		if r == ' ' {
			if prevSpace {
				continue
			}
			prevSpace = true
		} else {
			prevSpace = false
		}
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}
