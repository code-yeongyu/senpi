package overlays_test

import (
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
)

// model_selector_test.go ports the model-selector.ts contract: fuzzy search over
// (provider/id/name), a favorite marker (* for favorite), an auth-status
// indicator per provider, current-model ✓, and ctrl+f toggling favorite state.

func fauxModels() []overlays.ModelItem {
	return []overlays.ModelItem{
		{Provider: "openai", ID: "faux-1", Name: "One", AuthStatus: overlays.AuthConfigured},
		{Provider: "openai", ID: "faux-2", Name: "Two", AuthStatus: overlays.AuthConfigured},
		{Provider: "anthropic", ID: "claude-x", Name: "Claude", AuthStatus: overlays.AuthMissing},
	}
}

// TestModelSelectorConfirmEmitsSetModel: enter on the highlighted model emits
// set_model with provider+id, and persists as default.
func TestModelSelectorConfirmEmitsSetModel(t *testing.T) {
	o := overlays.NewModelSelector(overlays.ModelSelectorOptions{
		Models:       fauxModels(),
		CurrentModel: "openai/faux-1",
		Favorites:    overlays.Favorites(),
	})
	kb := newKB(t)
	res := o.HandleKey("\n", kb, "")
	if res.Kind != overlays.OutcomeSelect {
		t.Fatalf("kind = %v, want select", res.Kind)
	}
	if res.Command != "set_model" {
		t.Errorf("command = %q, want set_model", res.Command)
	}
	if res.Fields["provider"] == nil || res.Fields["modelId"] == nil {
		t.Errorf("fields missing provider/modelId: %+v", res.Fields)
	}
}

// TestModelSelectorFuzzyFilter narrows the list to matching models.
func TestModelSelectorFuzzyFilter(t *testing.T) {
	o := overlays.NewModelSelector(overlays.ModelSelectorOptions{
		Models:       fauxModels(),
		CurrentModel: "openai/faux-1",
		Favorites:    overlays.Favorites(),
	})
	kb := newKB(t)
	// Type "claude" into the search input.
	for _, ch := range "claude" {
		o.HandleKey(string(ch), kb, "")
	}
	visible := o.VisibleModelIDs()
	if len(visible) != 1 || visible[0] != "anthropic/claude-x" {
		t.Errorf("filtered = %v, want [anthropic/claude-x]", visible)
	}
}

// TestModelSelectorToggleFavorite: ctrl+f (\x06) on the highlighted /model row
// marks it favorite and surfaces the * marker + onFavoriteChange payload.
func TestModelSelectorToggleFavorite(t *testing.T) {
	o := overlays.NewModelSelector(overlays.ModelSelectorOptions{
		Models:       fauxModels(),
		CurrentModel: "openai/faux-1",
		Favorites:    overlays.Favorites(),
	})
	kb := newKB(t)
	o.HandleKey("\x06", kb, "")
	fav := o.CurrentFavorites()
	if !fav.IsFavoriteModel("openai/faux-1") {
		t.Errorf("faux-1 should be favorite after ctrl+f")
	}
	out := strings.Join(o.RenderPlain(120), "\n")
	if !strings.Contains(out, "* faux-1") {
		t.Errorf("expected '* faux-1' marker; got:\n%s", out)
	}
}

// TestModelSelectorAuthStatusIndicator: the list surfaces an auth-status
// indicator distinguishing configured vs missing-auth providers.
func TestModelSelectorAuthStatusIndicator(t *testing.T) {
	o := overlays.NewModelSelector(overlays.ModelSelectorOptions{
		Models:       fauxModels(),
		CurrentModel: "openai/faux-1",
		Favorites:    overlays.Favorites(),
	})
	// Move to the anthropic (missing-auth) model and assert its indicator differs.
	kb := newKB(t)
	for _, ch := range "claude" {
		o.HandleKey(string(ch), kb, "")
	}
	out := strings.Join(o.RenderPlain(120), "\n")
	if !strings.Contains(out, "no auth") && !strings.Contains(out, "login") {
		t.Errorf("expected an auth-missing indicator for anthropic; got:\n%s", out)
	}
}

// TestModelSelectorZeroModels: an empty model set renders a no-results/notice and
// never crashes; enter is a no-op.
func TestModelSelectorZeroModels(t *testing.T) {
	o := overlays.NewModelSelector(overlays.ModelSelectorOptions{
		Models:    nil,
		Favorites: overlays.Favorites(),
	})
	out := strings.Join(o.RenderPlain(120), "\n")
	if !strings.Contains(strings.ToLower(out), "no ") {
		t.Errorf("expected a 'no models' notice; got:\n%s", out)
	}
	kb := newKB(t)
	res := o.HandleKey("\n", kb, "")
	if res.Kind == overlays.OutcomeSelect {
		t.Errorf("confirm on empty list must not select")
	}
}

// TestModelSelectorCancelRestores: esc restores editor text.
func TestModelSelectorCancelRestores(t *testing.T) {
	o := overlays.NewModelSelector(overlays.ModelSelectorOptions{Models: fauxModels(), Favorites: overlays.Favorites()})
	kb := newKB(t)
	res := o.HandleKey("\x1b", kb, "my draft")
	if res.Kind != overlays.OutcomeCancel || res.RestoreText != "my draft" {
		t.Errorf("cancel/restore failed: %+v", res)
	}
}
