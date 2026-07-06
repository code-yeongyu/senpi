package markdown

import (
	"strings"
	"testing"

	"github.com/yuin/goldmark"
	gast "github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// topLevelBlockStarts returns the byte offset (line start) of each top-level
// block in s, using the same tokenizer the renderer uses.
func topLevelBlockStarts(s string) []int {
	src := []byte(s)
	md := goldmark.New(gfmMarkdown()...)
	doc := md.Parser().Parse(text.NewReader(src))
	var starts []int
	for c := doc.FirstChild(); c != nil; c = c.NextSibling() {
		if !isConvertibleBlock(c) {
			continue
		}
		seg, ok := firstSegment(c)
		if !ok {
			continue
		}
		ls := seg.Start
		for ls > 0 && src[ls-1] != '\n' {
			ls--
		}
		starts = append(starts, ls)
	}
	// For fenced code blocks the first segment is the body line, not the opening
	// fence; back each start up over a preceding fence line if present.
	for i, st := range starts {
		if st == 0 {
			continue
		}
		prevStart := st - 1
		for prevStart > 0 && src[prevStart-1] != '\n' {
			prevStart--
		}
		prevLine := strings.TrimSpace(string(src[prevStart : st-1]))
		if fenceMarkerRe.MatchString(prevLine) {
			starts[i] = prevStart
		}
	}
	_ = gast.KindDocument
	return starts
}

// Ported from markdown.test.ts describe("Streaming code fences").
func TestStreaming_StabilizePartialClosingFence(t *testing.T) {
	cases := []struct {
		input    string
		expected []string
	}{
		{"```ts\nconst x = 1;\n``", []string{"```ts", "  const x = 1;", "```"}},
		{"```md\nnot a closing fence:\n``\n```", []string{"```md", "  not a closing fence:", "  ``", "```"}},
		{"```ts\n``", []string{"```ts", "", "```"}},
		{"````\n```", []string{"```", "", "```"}},
		{"~~~~~\n~~~~", []string{"```", "", "```"}},
		{"```md\nnot a closing fence:\n``\n```\n\nafter", []string{"```md", "  not a closing fence:", "  ``", "```", "", "after"}},
	}
	for _, c := range cases {
		m := New(c.input, 0, 0, defaultMarkdownTheme(), nil, nil)
		pl := plain(m.Render(80))
		assertLinesEqual(t, pl, c.expected)
	}

	partial := New("```ts\nconst x = 1;\n``", 0, 0, defaultMarkdownTheme(), nil, nil)
	complete := New("```ts\nconst x = 1;\n```", 0, 0, defaultMarkdownTheme(), nil, nil)
	if len(partial.Render(80)) != len(complete.Render(80)) {
		t.Fatalf("partial (%d) and complete (%d) render must have equal line counts",
			len(partial.Render(80)), len(complete.Render(80)))
	}
}

// Streaming simulator: append chunks and, at every step, assert the core
// invariant — finalized lines NEVER reflow. A line is finalized when it belongs
// to a block that is already CLOSED in the source (the last block is still open
// and may change). We render the source with the last top-level block removed:
// those lines are the ground-truth stable region and must appear byte-for-byte
// as a leading run of the full render at every subsequent step. Exercises
// mid-fence (incl. partial closing fence), mid-table, and mid-list streaming.
func TestStreaming_FinalizedPrefixesByteStable(t *testing.T) {
	scripts := [][]string{
		// mid-fence stream (incl. partial closing fence `` before final ```)
		{"Intro paragraph line one.\n", "\n", "```", "ts\n", "const ", "x = 1;\n", "const y = 2;\n", "``", "\n", "```", "\n\ndone"},
		// mid-table stream (row splits across chunks)
		{"Header text.\n\n", "| A | B |\n", "| --- | --- |\n", "| 1 | 2 |\n", "| 3 ", "| 4 |\n", "\nafter"},
		// nested list stream
		{"- Item 1\n", "  - Nested ", "1.1\n", "- Item 2\n", "\npara"},
	}

	const width = 80
	for si, chunks := range scripts {
		acc := ""
		var stablePrev []string
		for ci := range chunks {
			acc += chunks[ci]

			// Ground truth: everything before the last top-level block start is
			// closed and cannot change; render only that closed region.
			closedSrc := closedBlocksPrefix(acc)
			var stable []string
			if closedSrc != "" {
				stable = New(closedSrc, 0, 0, defaultMarkdownTheme(), nil, nil).Render(width)
				// Drop the trailing separator line the closed-prefix render adds
				// because the closed region is momentarily the whole document.
				for len(stable) > 0 && stable[len(stable)-1] == blankLineOfWidth(width) {
					stable = stable[:len(stable)-1]
				}
			}
			full := New(acc, 0, 0, defaultMarkdownTheme(), nil, nil).Render(width)

			if len(stable) > len(full) {
				t.Fatalf("script %d chunk %d: full render (%d) shorter than closed prefix (%d)\nacc=%q",
					si, ci, len(full), len(stable), acc)
			}
			for i := 0; i < len(stable); i++ {
				if stable[i] != full[i] {
					t.Fatalf("script %d chunk %d: finalized line %d reflowed\n stable=%q\n full  =%q\nacc=%q",
						si, ci, i, stable[i], full[i], acc)
				}
			}
			// The closed region only ever grows; its render must extend the prior
			// closed render (monotonic stability — closed lines never disappear).
			for i := 0; i < len(stablePrev) && i < len(stable); i++ {
				if stablePrev[i] != stable[i] {
					t.Fatalf("script %d chunk %d: previously-closed line %d changed\n prev=%q\n now =%q\nacc=%q",
						si, ci, i, stablePrev[i], stable[i], acc)
				}
			}
			stablePrev = stable
		}
	}
}

// closedBlocksPrefix returns the source of every top-level block except the
// last (open) one. The split point is the start of the last top-level block, as
// reported by goldmark's block boundaries; if there is only one block, "".
func closedBlocksPrefix(s string) string {
	starts := topLevelBlockStarts(s)
	if len(starts) < 2 {
		return ""
	}
	return s[:starts[len(starts)-1]]
}

func blankLineOfWidth(width int) string {
	return strings.Repeat(" ", width)
}
