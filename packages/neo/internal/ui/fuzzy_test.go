package ui

import "testing"

// Contract source: packages/tui/test/fuzzy.test.ts (fuzzyMatch + fuzzyFilter).
// Every case below is a 1:1 port of a TS `it(...)` block; the mapping table
// (tui test name -> Go test name) is recorded in the task-8 evidence file. The
// scoring parity (consecutive/gap/word-boundary/exact/swap penalties) is the
// binding contract, so these assert the SAME ordering and match/no-match the TS
// suite asserts, not merely "some" fuzzy behavior.

func TestFuzzyMatch_EmptyQueryMatchesEverythingScoreZero(t *testing.T) {
	r := FuzzyMatch("", "anything")
	if !r.Matches {
		t.Fatalf("empty query should match, got matches=false")
	}
	if r.Score != 0 {
		t.Fatalf("empty query score: want 0, got %v", r.Score)
	}
}

func TestFuzzyMatch_QueryLongerThanTextDoesNotMatch(t *testing.T) {
	r := FuzzyMatch("longquery", "short")
	if r.Matches {
		t.Fatalf("query longer than text should not match")
	}
}

func TestFuzzyMatch_ExactMatchHasGoodScore(t *testing.T) {
	r := FuzzyMatch("test", "test")
	if !r.Matches {
		t.Fatalf("exact match should match")
	}
	if r.Score >= 0 {
		t.Fatalf("exact match score should be negative (consecutive+exact bonuses), got %v", r.Score)
	}
}

func TestFuzzyMatch_CharactersMustAppearInOrder(t *testing.T) {
	inOrder := FuzzyMatch("abc", "aXbXc")
	if !inOrder.Matches {
		t.Fatalf("in-order chars should match")
	}
	outOfOrder := FuzzyMatch("abc", "cba")
	if outOfOrder.Matches {
		t.Fatalf("out-of-order chars should not match")
	}
}

func TestFuzzyMatch_CaseInsensitive(t *testing.T) {
	if !FuzzyMatch("ABC", "abc").Matches {
		t.Fatalf("ABC vs abc should match (case-insensitive)")
	}
	if !FuzzyMatch("abc", "ABC").Matches {
		t.Fatalf("abc vs ABC should match (case-insensitive)")
	}
}

func TestFuzzyMatch_ConsecutiveBeatsScattered(t *testing.T) {
	consecutive := FuzzyMatch("foo", "foobar")
	scattered := FuzzyMatch("foo", "f_o_o_bar")
	if !consecutive.Matches || !scattered.Matches {
		t.Fatalf("both should match")
	}
	if !(consecutive.Score < scattered.Score) {
		t.Fatalf("consecutive score (%v) should be < scattered score (%v)", consecutive.Score, scattered.Score)
	}
}

func TestFuzzyMatch_WordBoundaryBeatsNonBoundary(t *testing.T) {
	atBoundary := FuzzyMatch("fb", "foo-bar")
	notAtBoundary := FuzzyMatch("fb", "afbx")
	if !atBoundary.Matches || !notAtBoundary.Matches {
		t.Fatalf("both should match")
	}
	if !(atBoundary.Score < notAtBoundary.Score) {
		t.Fatalf("word-boundary score (%v) should be < non-boundary score (%v)", atBoundary.Score, notAtBoundary.Score)
	}
}

func TestFuzzyMatch_SwappedAlphaNumericTokens(t *testing.T) {
	r := FuzzyMatch("codex52", "gpt-5.2-codex")
	if !r.Matches {
		t.Fatalf("swapped alphanumeric tokens should match")
	}
}

func TestFuzzyMatch_AdjacentSwappedAlphaNumericChars(t *testing.T) {
	r := FuzzyMatch("gpt5a", "gpt-a5")
	if !r.Matches {
		t.Fatalf("adjacent swapped alphanumeric chars should match")
	}
}

func TestFuzzyFilter_EmptyQueryReturnsAllUnchanged(t *testing.T) {
	items := []string{"apple", "banana", "cherry"}
	got := FuzzyFilter(items, "", func(s string) string { return s })
	if len(got) != len(items) {
		t.Fatalf("empty query: want %d items, got %d", len(items), len(got))
	}
	for i := range items {
		if got[i] != items[i] {
			t.Fatalf("empty query: order changed at %d: want %q got %q", i, items[i], got[i])
		}
	}
}

func TestFuzzyFilter_FiltersOutNonMatching(t *testing.T) {
	items := []string{"apple", "banana", "cherry"}
	got := FuzzyFilter(items, "an", func(s string) string { return s })
	if !contains(got, "banana") {
		t.Fatalf("want banana in result")
	}
	if contains(got, "apple") || contains(got, "cherry") {
		t.Fatalf("apple/cherry should be filtered out, got %v", got)
	}
}

func TestFuzzyFilter_SortsByMatchQuality(t *testing.T) {
	items := []string{"a_p_p", "app", "application"}
	got := FuzzyFilter(items, "app", func(s string) string { return s })
	if len(got) == 0 || got[0] != "app" {
		t.Fatalf("expected \"app\" first (exact consecutive), got %v", got)
	}
}

func TestFuzzyFilter_PrioritizesExactOverLongerPrefix(t *testing.T) {
	items := []string{"clone", "cl"}
	got := FuzzyFilter(items, "cl", func(s string) string { return s })
	want := []string{"cl", "clone"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("want %v, got %v", want, got)
	}
}

func TestFuzzyFilter_CustomGetText(t *testing.T) {
	type m struct {
		name string
		id   int
	}
	items := []m{{"foo", 1}, {"bar", 2}, {"foobar", 3}}
	got := FuzzyFilter(items, "foo", func(x m) string { return x.name })
	if len(got) != 2 {
		t.Fatalf("want 2 matches, got %d (%v)", len(got), got)
	}
	names := map[string]bool{}
	for _, x := range got {
		names[x.name] = true
	}
	if !names["foo"] || !names["foobar"] {
		t.Fatalf("want foo+foobar, got %v", got)
	}
}

func TestFuzzyFilter_SlashSeparatedProviderModelReordered(t *testing.T) {
	type model struct {
		id, provider string
	}
	item := model{id: "gpt-5.5", provider: "openai-codex"}
	got := FuzzyFilter([]model{item}, "openai-codex/gpt-5.5", func(m model) string {
		return m.id + " " + m.provider
	})
	if len(got) != 1 || got[0] != item {
		t.Fatalf("slash-separated query should match reordered text, got %v", got)
	}
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
