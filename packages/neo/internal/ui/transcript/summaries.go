package transcript

import (
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/markdown"
)

// BranchSummaryMessage renders a collapsible branch-summary entry. Collapsed:
// `[branch] Branch summary (<key> to expand)`. Expanded: the full summary body.
// Port of branch-summary-message.ts. expandHint is the resolved keybinding text
// for app.tools.expand (resolved through the keybinding manager at the app
// layer; never a hardcoded key here).
type BranchSummaryMessage struct {
	summary    string
	expandHint string
	theme      RenderTheme
	expanded   bool
}

// NewBranchSummaryMessage builds a branch-summary renderer.
func NewBranchSummaryMessage(summary, expandHint string, t RenderTheme) *BranchSummaryMessage {
	return &BranchSummaryMessage{summary: summary, expandHint: expandHint, theme: t}
}

// SetExpanded toggles the expanded state.
func (b *BranchSummaryMessage) SetExpanded(expanded bool) { b.expanded = expanded }

// Render lays out the branch summary.
func (b *BranchSummaryMessage) Render(width int) []string {
	var out []string
	out = append(out, b.theme.CustomLabel(bold("[branch]")))
	out = append(out, "")
	if b.expanded {
		md := markdown.New("**Branch Summary**\n\n"+b.summary, 0, 0, b.theme.Markdown,
			&markdown.DefaultTextStyle{Color: b.theme.CustomText, BgColor: b.theme.CustomBg}, nil)
		out = append(out, md.Render(width)...)
	} else {
		line := b.theme.CustomText("Branch summary (") +
			b.theme.Dim(b.expandHint) +
			b.theme.CustomText(" to expand)")
		out = append(out, line)
	}
	return out
}

// CompactionSummaryMessage renders a collapsible compaction-summary entry.
// Collapsed shows the token count; expanded shows the summary body. Port of
// compaction-summary-message.ts.
type CompactionSummaryMessage struct {
	summary    CompactionSummary
	expandHint string
	theme      RenderTheme
	expanded   bool
}

// NewCompactionSummaryMessage builds a compaction-summary renderer.
func NewCompactionSummaryMessage(summary CompactionSummary, expandHint string, t RenderTheme) *CompactionSummaryMessage {
	return &CompactionSummaryMessage{summary: summary, expandHint: expandHint, theme: t}
}

// SetExpanded toggles the expanded state.
func (c *CompactionSummaryMessage) SetExpanded(expanded bool) { c.expanded = expanded }

// Render lays out the compaction summary.
func (c *CompactionSummaryMessage) Render(width int) []string {
	tokenStr := formatThousands(c.summary.TokensBefore)
	var out []string
	out = append(out, c.theme.CustomLabel(bold("[compaction]")))
	out = append(out, "")
	if c.expanded {
		header := "**Compacted from " + tokenStr + " tokens**\n\n"
		md := markdown.New(header+c.summary.Summary, 0, 0, c.theme.Markdown,
			&markdown.DefaultTextStyle{Color: c.theme.CustomText, BgColor: c.theme.CustomBg}, nil)
		out = append(out, md.Render(width)...)
	} else {
		line := c.theme.CustomText("compacted from "+tokenStr+" tokens (") +
			c.theme.Dim(c.expandHint) +
			c.theme.CustomText(" to expand)")
		out = append(out, line)
	}
	return out
}

// SkillInvocationMessage renders a collapsible skill-invocation entry. Collapsed:
// `[skill] <name> (<key> to expand)`. Expanded: the skill name header + content.
// Port of skill-invocation-message.ts.
type SkillInvocationMessage struct {
	skill      SkillBlock
	expandHint string
	theme      RenderTheme
	expanded   bool
}

// NewSkillInvocationMessage builds a skill-invocation renderer.
func NewSkillInvocationMessage(skill SkillBlock, expandHint string, t RenderTheme) *SkillInvocationMessage {
	return &SkillInvocationMessage{skill: skill, expandHint: expandHint, theme: t}
}

// SetExpanded toggles the expanded state.
func (s *SkillInvocationMessage) SetExpanded(expanded bool) { s.expanded = expanded }

// Render lays out the skill invocation.
func (s *SkillInvocationMessage) Render(width int) []string {
	var out []string
	if s.expanded {
		out = append(out, s.theme.CustomLabel(bold("[skill]")))
		header := "**" + s.skill.Name + "**\n\n"
		md := markdown.New(header+s.skill.Content, 0, 0, s.theme.Markdown,
			&markdown.DefaultTextStyle{Color: s.theme.CustomText, BgColor: s.theme.CustomBg}, nil)
		out = append(out, md.Render(width)...)
	} else {
		line := s.theme.CustomLabel(bold("[skill]")+" ") +
			s.theme.CustomText(s.skill.Name) +
			s.theme.Dim(" ("+s.expandHint+" to expand)")
		out = append(out, line)
	}
	return out
}

func formatThousands(n int) string {
	s := itoaSigned(n)
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}
