package markdown

import (
	"strings"
	"testing"
)

// Ported from packages/tui/test/markdown.test.ts describe("Tables").

func TestTables_Simple(t *testing.T) {
	pl := render80Plain(t, "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |")
	for _, want := range []string{"Name", "Age", "Alice", "Bob", "│", "─"} {
		if !containsLine(pl, want) {
			t.Fatalf("missing %q in %#v", want, pl)
		}
	}
}

func TestTables_RowDividers(t *testing.T) {
	pl := render80Plain(t, "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |")
	dividers := 0
	for _, l := range pl {
		if strings.Contains(l, "┼") {
			dividers++
		}
	}
	if dividers != 2 {
		t.Fatalf("expected header + row divider (2 ┼ lines), got %d in %#v", dividers, pl)
	}
}

func TestTables_ColumnAtLeastLongestWord(t *testing.T) {
	longest := "superlongword"
	src := "| Column One | Column Two |\n| --- | --- |\n| " + longest + " short | otherword |\n| small | tiny |"
	m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := mapLines(m.Render(32), stripANSI)
	var dataLine string
	for _, l := range pl {
		if strings.Contains(l, longest) {
			dataLine = l
			break
		}
	}
	if dataLine == "" {
		t.Fatalf("expected data row containing longest word; got %#v", pl)
	}
	segs := strings.Split(dataLine, "│")
	if len(segs) < 3 {
		t.Fatalf("expected bordered segments, got %q", dataLine)
	}
	first := segs[1]
	firstColWidth := len([]rune(first)) - 2
	if firstColWidth < len(longest) {
		t.Fatalf("expected first column width >= %d, got %d (%q)", len(longest), firstColWidth, first)
	}
}

func TestTables_Alignment(t *testing.T) {
	src := "| Left | Center | Right |\n| :--- | :---: | ---: |\n| A | B | C |\n| Long text | Middle | End |"
	pl := render80Plain(t, src)
	for _, want := range []string{"Left", "Center", "Right", "Long text"} {
		if !containsLine(pl, want) {
			t.Fatalf("missing %q in %#v", want, pl)
		}
	}
}

func TestTables_VaryingColumnWidths(t *testing.T) {
	src := "| Short | Very long column header |\n| --- | --- |\n| A | This is a much longer cell content |\n| B | Short |"
	m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
	lines := m.Render(80)
	if len(lines) == 0 {
		t.Fatal("expected output")
	}
	pl := mapLines(lines, stripANSI)
	if !containsLine(pl, "Very long column header") || !containsLine(pl, "This is a much longer cell content") {
		t.Fatalf("missing content in %#v", pl)
	}
}

func TestTables_WrapWhenExceedsWidth(t *testing.T) {
	src := "| Command | Description | Example |\n| --- | --- | --- |\n| npm install | Install all dependencies | npm install |\n| npm run build | Build the project | npm run build |"
	m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(50))
	for _, l := range pl {
		if len([]rune(l)) > 50 {
			t.Fatalf("line exceeds width 50: %q (len %d)", l, len([]rune(l)))
		}
	}
	all := strings.Join(pl, " ")
	for _, want := range []string{"Command", "Description", "npm install", "Install"} {
		if !strings.Contains(all, want) {
			t.Fatalf("missing %q", want)
		}
	}
}

func TestTables_WrapLongCell(t *testing.T) {
	src := "| Header |\n| --- |\n| This is a very long cell content that should wrap |"
	m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(25))
	dataRows := 0
	for _, l := range pl {
		if strings.HasPrefix(l, "│") && !strings.Contains(l, "─") {
			dataRows++
		}
	}
	if dataRows <= 2 {
		t.Fatalf("expected wrapped rows, got %d in %#v", dataRows, pl)
	}
	all := strings.Join(pl, " ")
	for _, want := range []string{"very long", "cell content", "should wrap"} {
		if !strings.Contains(all, want) {
			t.Fatalf("missing %q", want)
		}
	}
}

func TestTables_WrapLongUnbrokenToken(t *testing.T) {
	SetCapabilities(Capabilities{Images: "", TrueColor: false, Hyperlinks: false})
	defer ResetCapabilities()
	url := "https://example.com/this/is/a/very/long/url/that/should/wrap"
	src := "| Value |\n| --- |\n| prefix " + url + " |"
	m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
	width := 30
	pl := plain(m.Render(width))
	for _, l := range pl {
		if len([]rune(l)) > width {
			t.Fatalf("line exceeds width %d: %q (len %d)", width, l, len([]rune(l)))
		}
	}
	var tableLines []string
	for _, l := range pl {
		if strings.HasPrefix(l, "│") {
			tableLines = append(tableLines, l)
		}
	}
	if len(tableLines) == 0 {
		t.Fatal("expected table rows")
	}
	for _, l := range tableLines {
		if c := strings.Count(l, "│"); c != 2 {
			t.Fatalf("expected 2 borders, got %d: %q", c, l)
		}
	}
	extracted := stripBox(strings.Join(pl, ""))
	if !strings.Contains(extracted, "prefix") || !strings.Contains(extracted, url) {
		t.Fatalf("missing prefix/url in %q", extracted)
	}
}

func TestTables_WrapStyledInlineCode(t *testing.T) {
	src := "| Code |\n| --- |\n| `averyveryveryverylongidentifier` |"
	m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
	width := 20
	lines := m.Render(width)
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "\x1b[33m") {
		t.Fatalf("inline code should be yellow-styled; joined=%q", joined)
	}
	pl := plain(lines)
	for _, l := range pl {
		if len([]rune(l)) > width {
			t.Fatalf("line exceeds width %d: %q", width, l)
		}
	}
	for _, l := range pl {
		if strings.HasPrefix(l, "│") {
			if c := strings.Count(l, "│"); c != 2 {
				t.Fatalf("expected 2 borders, got %d: %q", c, l)
			}
		}
	}
}

func TestTables_NarrowGraceful(t *testing.T) {
	src := "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |"
	m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
	lines := m.Render(15)
	if len(lines) == 0 {
		t.Fatal("should produce output")
	}
	for _, l := range plain(lines) {
		if len([]rune(l)) > 15 {
			t.Fatalf("line exceeds width 15: %q", l)
		}
	}
}

func TestTables_FitsNaturally(t *testing.T) {
	src := "| A | B |\n| --- | --- |\n| 1 | 2 |"
	pl := render80Plain(t, src)
	var header string
	for _, l := range pl {
		if strings.Contains(l, "A") && strings.Contains(l, "B") {
			header = l
			break
		}
	}
	if header == "" || !strings.Contains(header, "│") {
		t.Fatalf("expected bordered header, got %#v", pl)
	}
	if !containsBoth(pl, "├", "┼") {
		t.Fatalf("expected separator row in %#v", pl)
	}
	if !containsBoth(pl, "1", "2") {
		t.Fatalf("expected data row in %#v", pl)
	}
}

func TestTables_RespectPaddingX(t *testing.T) {
	src := "| Column One | Column Two |\n| --- | --- |\n| Data 1 | Data 2 |"
	m := New(src, 2, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(40))
	for _, l := range pl {
		if len([]rune(l)) > 40 {
			t.Fatalf("line exceeds width 40: %q", l)
		}
	}
	var row string
	for _, l := range pl {
		if strings.Contains(l, "│") {
			row = l
			break
		}
	}
	if !strings.HasPrefix(row, "  ") {
		t.Fatalf("table should have left padding, got %q", row)
	}
}

func TestTables_NoTrailingBlankLine(t *testing.T) {
	src := "| Name |\n| --- |\n| Alice |"
	m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(80))
	if len(pl) > 0 && pl[len(pl)-1] == "" {
		t.Fatalf("expected table to end without a blank line: %#v", pl)
	}
}

// helpers

func stripBox(s string) string {
	r := strings.NewReplacer("│", "", "├", "", "┤", "", "─", "", " ", "", "\t", "", "\n", "")
	return r.Replace(s)
}

func containsBoth(lines []string, a, b string) bool {
	for _, l := range lines {
		if strings.Contains(l, a) && strings.Contains(l, b) {
			return true
		}
	}
	return false
}
