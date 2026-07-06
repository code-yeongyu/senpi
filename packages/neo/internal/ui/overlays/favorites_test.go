package overlays_test

import (
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
)

// favorites_test.go ports the model-favorites.ts contract (the pure functions
// backing FavoriteModelsSelectorComponent + ctrl+p cycling) and asserts the
// favorites-aware cycle order.

func eq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestToggleFavoriteRemovesFromAllSentinel mirrors the favorite-model-selection
// contract: from the "all favorite" sentinel, toggling faux-2 off materializes
// the full list minus faux-2 (so [faux-1]).
func TestToggleFavoriteRemovesFromAllSentinel(t *testing.T) {
	all := []string{"p/faux-1", "p/faux-2"}
	// Start with an explicit full list (favoriteIds = all), toggle faux-2 off.
	fav := overlays.Favorites(all...)
	next := fav.ToggleFavoriteModel(all, "p/faux-2")
	if !eq(next.IDs, []string{"p/faux-1"}) {
		t.Errorf("toggle off = %v, want [p/faux-1]", next.IDs)
	}
	if next.IsFavoriteModel("p/faux-2") {
		t.Errorf("p/faux-2 should no longer be favorite")
	}
	if !next.IsFavoriteModel("p/faux-1") {
		t.Errorf("p/faux-1 should still be favorite")
	}
}

// TestToggleFavoriteFromEmptyAdds mirrors the /model row toggle: from an empty
// favorite list, ctrl+f on faux-1 adds it.
func TestToggleFavoriteFromEmptyAdds(t *testing.T) {
	all := []string{"p/faux-1", "p/faux-2"}
	fav := overlays.Favorites()
	next := fav.ToggleFavoriteModel(all, "p/faux-1")
	if !eq(next.IDs, []string{"p/faux-1"}) {
		t.Errorf("toggle add = %v, want [p/faux-1]", next.IDs)
	}
}

// TestAllSentinelEveryModelFavorite asserts the null sentinel treats every id as
// favorite.
func TestAllSentinelEveryModelFavorite(t *testing.T) {
	fav := overlays.AllFavorites()
	if !fav.IsFavoriteModel("anything/at-all") {
		t.Errorf("All sentinel must treat every id as favorite")
	}
}

// TestMoveFavoriteReorders mirrors moveFavoriteModel (alt+up/down reorder).
func TestMoveFavoriteReorders(t *testing.T) {
	fav := overlays.Favorites("a", "b", "c")
	up := fav.MoveFavoriteModel("c", -1)
	if !eq(up.IDs, []string{"a", "c", "b"}) {
		t.Errorf("move c up = %v, want [a c b]", up.IDs)
	}
	// Out of range: moving a up is a no-op.
	noop := fav.MoveFavoriteModel("a", -1)
	if !eq(noop.IDs, []string{"a", "b", "c"}) {
		t.Errorf("move a up (oob) = %v, want [a b c]", noop.IDs)
	}
}

// TestSortedFavoritesCycleOrder mirrors getSortedFavoriteModelIds: favorites
// first (in stored order), then non-favorites in original order. ctrl+p cycling
// walks exactly this order.
func TestSortedFavoritesCycleOrder(t *testing.T) {
	all := []string{"a", "b", "c", "d"}
	fav := overlays.Favorites("c", "a")
	got := fav.SortedFavoriteModelIDs(all)
	if !eq(got, []string{"c", "a", "b", "d"}) {
		t.Errorf("sorted = %v, want [c a b d]", got)
	}
	// All sentinel returns the input order unchanged.
	if got := overlays.AllFavorites().SortedFavoriteModelIDs(all); !eq(got, all) {
		t.Errorf("all-sentinel sorted = %v, want %v", got, all)
	}
}

// TestCycleModelHonorsFavorites asserts CycleModel walks the favorites-first
// order and wraps, mirroring the classic ctrl+p cycle.
func TestCycleModelHonorsFavorites(t *testing.T) {
	all := []string{"a", "b", "c", "d"}
	fav := overlays.Favorites("c", "a") // cycle order: c, a, b, d
	// Forward from "c": expect "a".
	if got := overlays.CycleModel(fav, all, "c", +1); got != "a" {
		t.Errorf("forward from c = %q, want a", got)
	}
	// Forward from "d" wraps to "c".
	if got := overlays.CycleModel(fav, all, "d", +1); got != "c" {
		t.Errorf("forward from d = %q, want c (wrap)", got)
	}
	// Backward from "c" wraps to "d".
	if got := overlays.CycleModel(fav, all, "c", -1); got != "d" {
		t.Errorf("backward from c = %q, want d (wrap)", got)
	}
}
