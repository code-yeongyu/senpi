package overlays

// favorites.go is a faithful Go port of
// packages/coding-agent/src/modes/interactive/components/model-favorites.ts. The
// favorite set is represented as (ids, all): a nil ids slice means "all models
// are favorite" (the TS `null` sentinel), tracked separately by the All flag.
//
// ctrl+p model cycling (app.model.cycleForward / cycleBackward) honors this
// ordering via SortedFavoriteModelIDs, so the classic favorites-aware cycle is
// reproduced exactly.

// FavoriteModelIDs mirrors the TS `FavoriteModelIds = string[] | null`. All==true
// is the `null` sentinel (every model favorite); otherwise IDs is the explicit
// favorite list.
type FavoriteModelIDs struct {
	IDs []string
	All bool
}

// AllFavorites returns the "everything is favorite" sentinel (TS null).
func AllFavorites() FavoriteModelIDs { return FavoriteModelIDs{All: true} }

// Favorites builds an explicit favorite set.
func Favorites(ids ...string) FavoriteModelIDs {
	return FavoriteModelIDs{IDs: append([]string(nil), ids...)}
}

// IsFavoriteModel mirrors isFavoriteModel: null (All) → every id is favorite;
// otherwise membership in IDs.
func (f FavoriteModelIDs) IsFavoriteModel(id string) bool {
	if f.All {
		return true
	}
	for _, x := range f.IDs {
		if x == id {
			return true
		}
	}
	return false
}

// ToggleFavoriteModel mirrors toggleFavoriteModel. From the All sentinel,
// toggling a model OFF materializes the full list minus that id. Otherwise it
// adds/removes the id.
func (f FavoriteModelIDs) ToggleFavoriteModel(allIDs []string, id string) FavoriteModelIDs {
	if f.All {
		out := make([]string, 0, len(allIDs))
		for _, candidate := range allIDs {
			if candidate != id {
				out = append(out, candidate)
			}
		}
		return FavoriteModelIDs{IDs: out}
	}
	idx := indexOf(f.IDs, id)
	if idx >= 0 {
		out := append([]string(nil), f.IDs[:idx]...)
		out = append(out, f.IDs[idx+1:]...)
		return FavoriteModelIDs{IDs: out}
	}
	return FavoriteModelIDs{IDs: append(append([]string(nil), f.IDs...), id)}
}

// MoveFavoriteModel mirrors moveFavoriteModel: swap the id with its neighbor by
// delta; the All sentinel and out-of-range moves are no-ops (returning a copy).
func (f FavoriteModelIDs) MoveFavoriteModel(id string, delta int) FavoriteModelIDs {
	if f.All {
		return FavoriteModelIDs{All: true}
	}
	index := indexOf(f.IDs, id)
	out := append([]string(nil), f.IDs...)
	if index < 0 {
		return FavoriteModelIDs{IDs: out}
	}
	newIndex := index + delta
	if newIndex < 0 || newIndex >= len(out) {
		return FavoriteModelIDs{IDs: out}
	}
	out[index], out[newIndex] = out[newIndex], out[index]
	return FavoriteModelIDs{IDs: out}
}

// SortedFavoriteModelIDs mirrors getSortedFavoriteModelIds: favorites first (in
// their stored order), then the remaining allIDs in their original order. The
// All sentinel returns allIDs unchanged. This is the exact order ctrl+p cycling
// walks.
func (f FavoriteModelIDs) SortedFavoriteModelIDs(allIDs []string) []string {
	if f.All {
		return append([]string(nil), allIDs...)
	}
	favSet := make(map[string]bool, len(f.IDs))
	for _, id := range f.IDs {
		favSet[id] = true
	}
	out := append([]string(nil), f.IDs...)
	for _, id := range allIDs {
		if !favSet[id] {
			out = append(out, id)
		}
	}
	return out
}

// FavoriteModels mirrors favoriteModels: mark the target ids (default: all) as
// favorite. When the result would cover every model, it collapses to the All
// sentinel (matching the TS `result.length === allIds.length ? null`).
func (f FavoriteModelIDs) FavoriteModels(allIDs []string, targetIDs []string) FavoriteModelIDs {
	if f.All {
		return FavoriteModelIDs{All: true}
	}
	targets := targetIDs
	if targets == nil {
		targets = allIDs
	}
	result := append([]string(nil), f.IDs...)
	for _, id := range targets {
		if indexOf(result, id) < 0 {
			result = append(result, id)
		}
	}
	if len(result) == len(allIDs) {
		return FavoriteModelIDs{All: true}
	}
	return FavoriteModelIDs{IDs: result}
}

// ClearFavoriteModels mirrors clearFavoriteModels: remove the target ids
// (default: all favorites). From the All sentinel, clearing yields either the
// complement of targets or the empty explicit list.
func (f FavoriteModelIDs) ClearFavoriteModels(allIDs []string, targetIDs []string) FavoriteModelIDs {
	if f.All {
		if targetIDs != nil {
			out := make([]string, 0, len(allIDs))
			for _, id := range allIDs {
				if indexOf(targetIDs, id) < 0 {
					out = append(out, id)
				}
			}
			return FavoriteModelIDs{IDs: out}
		}
		return FavoriteModelIDs{IDs: []string{}}
	}
	targets := targetIDs
	if targets == nil {
		targets = f.IDs
	}
	targetSet := make(map[string]bool, len(targets))
	for _, id := range targets {
		targetSet[id] = true
	}
	out := make([]string, 0, len(f.IDs))
	for _, id := range f.IDs {
		if !targetSet[id] {
			out = append(out, id)
		}
	}
	return FavoriteModelIDs{IDs: out}
}

// CycleModel returns the id reached by cycling from currentID by delta (+1
// forward / -1 backward) through the favorites-first order, wrapping at the
// ends. This is the app.model.cycleForward / cycleBackward behavior: ctrl+p
// walks favorites before the rest, honoring the stored favorite order. A
// currentID not in the order starts the walk from the beginning.
func CycleModel(f FavoriteModelIDs, allIDs []string, currentID string, delta int) string {
	order := f.SortedFavoriteModelIDs(allIDs)
	n := len(order)
	if n == 0 {
		return currentID
	}
	idx := indexOf(order, currentID)
	if idx < 0 {
		if delta >= 0 {
			return order[0]
		}
		return order[n-1]
	}
	next := (idx + delta) % n
	if next < 0 {
		next += n
	}
	return order[next]
}

func indexOf(xs []string, x string) int {
	for i, v := range xs {
		if v == x {
			return i
		}
	}
	return -1
}
