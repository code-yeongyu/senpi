package markdown

import (
	"strings"
	"testing"
)

// Ported from markdown.test.ts describe("Links"). Each case pins capabilities
// exactly as the tui test does and resets afterward.

func TestLinks_NoDuplicateAutolinkedEmail(t *testing.T) {
	SetCapabilities(Capabilities{Images: "", TrueColor: false, Hyperlinks: false})
	defer ResetCapabilities()
	m := New("Contact user@example.com for help", 0, 0, defaultMarkdownTheme(), nil, nil)
	joinedPlain := strings.Join(mapLines(m.Render(80), stripANSI), " ")
	if !strings.Contains(joinedPlain, "user@example.com") {
		t.Fatal("should contain email")
	}
	if strings.Contains(joinedPlain, "mailto:") {
		t.Fatal("should not show mailto: prefix for autolinked emails")
	}
}

func TestLinks_NoDuplicateBareURL(t *testing.T) {
	SetCapabilities(Capabilities{Images: "", TrueColor: false, Hyperlinks: false})
	defer ResetCapabilities()
	m := New("Visit https://example.com for more", 0, 0, defaultMarkdownTheme(), nil, nil)
	joinedPlain := strings.Join(mapLines(m.Render(80), stripANSI), " ")
	if c := strings.Count(joinedPlain, "https://example.com"); c != 1 {
		t.Fatalf("URL should appear exactly once, got %d", c)
	}
}

func TestLinks_ParenURLWhenNoHyperlinks(t *testing.T) {
	SetCapabilities(Capabilities{Images: "", TrueColor: false, Hyperlinks: false})
	defer ResetCapabilities()
	m := New("[click here](https://example.com)", 0, 0, defaultMarkdownTheme(), nil, nil)
	joinedPlain := strings.Join(mapLines(m.Render(80), stripANSI), " ")
	if !strings.Contains(joinedPlain, "click here") {
		t.Fatal("should contain link text")
	}
	if !strings.Contains(joinedPlain, "(https://example.com)") {
		t.Fatal("should show URL in parentheses")
	}
}

func TestLinks_MailtoParenWhenNoHyperlinks(t *testing.T) {
	SetCapabilities(Capabilities{Images: "", TrueColor: false, Hyperlinks: false})
	defer ResetCapabilities()
	m := New("[Email me](mailto:test@example.com)", 0, 0, defaultMarkdownTheme(), nil, nil)
	joinedPlain := strings.Join(mapLines(m.Render(80), stripANSI), " ")
	if !strings.Contains(joinedPlain, "Email me") {
		t.Fatal("should contain link text")
	}
	if !strings.Contains(joinedPlain, "(mailto:test@example.com)") {
		t.Fatal("should show mailto URL in parentheses")
	}
}

func TestLinks_OSC8WhenHyperlinksSupported(t *testing.T) {
	SetCapabilities(Capabilities{Images: "", TrueColor: false, Hyperlinks: true})
	defer ResetCapabilities()
	m := New("[click here](https://example.com)", 0, 0, defaultMarkdownTheme(), nil, nil)
	joined := strings.Join(m.Render(80), "")
	if !strings.Contains(joined, "\x1b]8;;https://example.com\x1b\\") {
		t.Fatal("should contain OSC 8 open sequence")
	}
	if !strings.Contains(joined, "\x1b]8;;\x1b\\") {
		t.Fatal("should contain OSC 8 close sequence")
	}
	if strings.Contains(stripOSC8(stripANSI(joined)), "(https://example.com)") {
		t.Fatal("URL should not appear inline in parentheses")
	}
	if !strings.Contains(stripOSC8andSGR(joined), "click here") {
		t.Fatal("should contain link text")
	}
}

func TestLinks_OSC8MailtoWhenSupported(t *testing.T) {
	SetCapabilities(Capabilities{Images: "", TrueColor: false, Hyperlinks: true})
	defer ResetCapabilities()
	m := New("[Email me](mailto:test@example.com)", 0, 0, defaultMarkdownTheme(), nil, nil)
	joined := strings.Join(m.Render(80), "")
	if !strings.Contains(joined, "\x1b]8;;mailto:test@example.com\x1b\\") {
		t.Fatal("should contain OSC 8 open with mailto URL")
	}
	if !strings.Contains(joined, "\x1b]8;;\x1b\\") {
		t.Fatal("should contain OSC 8 close sequence")
	}
}

func TestLinks_OSC8BareURLWhenSupported(t *testing.T) {
	SetCapabilities(Capabilities{Images: "", TrueColor: false, Hyperlinks: true})
	defer ResetCapabilities()
	m := New("Visit https://example.com for more", 0, 0, defaultMarkdownTheme(), nil, nil)
	joined := strings.Join(m.Render(80), "")
	if !strings.Contains(joined, "\x1b]8;;https://example.com\x1b\\") {
		t.Fatal("should contain OSC 8 hyperlink")
	}
	if strings.Contains(stripOSC8andSGR(joined), "(https://example.com)") {
		t.Fatal("URL should not appear twice")
	}
}

// stripOSC8 removes OSC 8 hyperlink sequences (open+close) leaving inner text.
func stripOSC8(s string) string {
	var b strings.Builder
	i := 0
	for i < len(s) {
		if strings.HasPrefix(s[i:], "\x1b]8;") {
			// consume until ST (\x1b\\) or BEL (\x07)
			j := i + 4
			for j < len(s) {
				if s[j] == 0x07 {
					j++
					break
				}
				if s[j] == 0x1b && j+1 < len(s) && s[j+1] == '\\' {
					j += 2
					break
				}
				j++
			}
			i = j
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

func stripOSC8andSGR(s string) string { return stripANSI(stripOSC8(s)) }
