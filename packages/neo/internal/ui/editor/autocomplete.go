package editor

import (
	"context"
	"regexp"
	"strings"
)

// defaultTriggerChars are the always-on autocomplete trigger characters.
var defaultTriggerChars = []string{"@", "#"}

// attachmentDebounce mirrors ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS in editor.ts.
// In the Go port the debounce is a boolean gate fired by AdvanceDebounce (the
// tests replace the wall clock, matching the tui suite's await setTimeout(50)).
const attachmentDebounceActive = true

// Item is one autocomplete suggestion.
type Item struct {
	Value       string
	Label       string
	Description string
}

// Suggestions is a provider result: matching items and the prefix they replace.
type Suggestions struct {
	Items  []Item
	Prefix string
}

// ApplyResult is the new document state after applying a completion.
type ApplyResult struct {
	Lines      []string
	CursorLine int
	CursorCol  int
}

// AutocompleteProvider supplies completion suggestions. Mirrors the tui
// AutocompleteProvider interface (getSuggestions/applyCompletion + optional
// triggerCharacters + shouldTriggerFileCompletion).
type AutocompleteProvider interface {
	GetSuggestions(lines []string, cursorLine, cursorCol int, force bool) (*Suggestions, error)
	ApplyCompletion(lines []string, cursorLine, cursorCol int, item Item, prefix string) ApplyResult
}

// CtxAutocompleteProvider is the optional context-aware variant of a provider.
// When a provider implements it, the editor passes a cancellable context to
// GetSuggestionsCtx and cancels it the moment a newer request supersedes this
// one — the Go analogue of the tui `options.signal` AbortSignal. Providers that
// perform in-flight async work (e.g. a filesystem or RPC lookup) observe the
// cancellation via ctx.Done(). Sync providers need not implement this.
type CtxAutocompleteProvider interface {
	AutocompleteProvider
	GetSuggestionsCtx(ctx context.Context, lines []string, cursorLine, cursorCol int, force bool) (*Suggestions, error)
}

// triggerCharProvider is optionally implemented to declare extra trigger chars.
type triggerCharProvider interface {
	TriggerCharacters() []string
}

// fileCompletionGate is optionally implemented to veto force-file completion.
type fileCompletionGate interface {
	ShouldTriggerFileCompletion(lines []string, cursorLine, cursorCol int) bool
}

type acStateKind int

const (
	acNone acStateKind = iota
	acRegular
	acForce
)

// SetAutocompleteProvider installs a provider, resetting trigger characters.
func (e *Editor) SetAutocompleteProvider(p AutocompleteProvider) {
	e.cancelAutocomplete()
	e.provider = p
	extra := []string(nil)
	if tp, ok := p.(triggerCharProvider); ok {
		extra = tp.TriggerCharacters()
	}
	e.setTriggerCharacters(extra)
}

func (e *Editor) setTriggerCharacters(extra []string) {
	next := append([]string(nil), defaultTriggerChars...)
	for _, c := range extra {
		if runeLen(c) != 1 || c == "/" || isWhitespaceChar(c) || contains(next, c) {
			continue
		}
		next = append(next, c)
	}
	e.triggerChars = next
}

// IsShowingAutocomplete reports whether the popup is open.
func (e *Editor) IsShowingAutocomplete() bool { return e.acState != acNone }

// FlushAutocomplete drains any pending immediate autocomplete request. Analogous
// to the tui suite's flushAutocomplete().
func (e *Editor) FlushAutocomplete() {}

// AdvanceDebounce fires a pending debounced autocomplete request deterministically
// (the tests use this instead of a wall-clock timer).
func (e *Editor) AdvanceDebounce() {
	if e.pendingDebounce && e.pendingDebounceFn != nil {
		fn := e.pendingDebounceFn
		e.pendingDebounce = false
		e.pendingDebounceFn = nil
		fn()
	}
}

func (e *Editor) cancelAutocompleteRequest() {
	e.pendingDebounce = false
	e.pendingDebounceFn = nil
	// Abort any in-flight context-aware request (tui: autocompleteAbort?.abort()).
	if e.acInflight != nil {
		e.acInflight.cancel()
		e.acInflight = nil
	}
}

// WaitForAutocompleteInFlight blocks until a context-aware provider request that
// was just started has actually begun executing (its goroutine is running and
// the provider has observed the request). It is the deterministic seam the tui
// suite gets from `await setTimeout(...)` reaching the pending getSuggestions
// promise. No-op when there is no in-flight request.
func (e *Editor) WaitForAutocompleteInFlight() {
	req := e.acInflight
	if req == nil {
		return
	}
	<-req.started
}

// WaitForAutocompleteRequestsSettled blocks until every context-aware request
// goroutine started so far has returned. Sync requests are already settled when
// they return, so this is only meaningful for CtxAutocompleteProvider.
func (e *Editor) WaitForAutocompleteRequestsSettled() {
	e.acWG.Wait()
}

func (e *Editor) cancelAutocomplete() {
	e.cancelAutocompleteRequest()
	e.acState = acNone
	e.acList = nil
	e.acPrefix = ""
}

func (e *Editor) updateAutocomplete() {
	if e.acState == acNone || e.provider == nil {
		return
	}
	e.requestAutocomplete(e.acState == acForce, false)
}

// maybeTriggerAutocompleteAfterInsert mirrors the auto-trigger heuristics in
// insertCharacter().
func (e *Editor) maybeTriggerAutocompleteAfterInsert(char string) {
	if e.acState != acNone {
		e.updateAutocomplete()
		return
	}
	if char == "/" && e.isAtStartOfMessage() {
		e.tryTriggerAutocomplete()
		return
	}
	if contains(e.triggerChars, char) {
		line := e.curLine()
		before := runeSlice(line, 0, e.state.cursorCol)
		r := []rune(before)
		if len(r) == 1 || (len(r) >= 2 && (r[len(r)-2] == ' ' || r[len(r)-2] == '\t')) {
			e.tryTriggerAutocomplete()
		}
		return
	}
	if wordCharRe.MatchString(char) {
		line := e.curLine()
		before := runeSlice(line, 0, e.state.cursorCol)
		if e.isInSlashCommandContext(before) {
			e.tryTriggerAutocomplete()
		} else if e.triggerPattern().MatchString(before) {
			e.tryTriggerAutocomplete()
		}
	}
}

// retriggerAutocompleteAfterEdit mirrors the backspace/forward-delete follow-up.
func (e *Editor) retriggerAutocompleteAfterEdit() {
	if e.acState != acNone {
		e.updateAutocomplete()
		return
	}
	line := e.curLine()
	before := runeSlice(line, 0, e.state.cursorCol)
	if e.isInSlashCommandContext(before) {
		e.tryTriggerAutocomplete()
	} else if e.triggerPattern().MatchString(before) {
		e.tryTriggerAutocomplete()
	}
}

var wordCharRe = regexp.MustCompile(`[a-zA-Z0-9.\-_]`)

func (e *Editor) isSlashMenuAllowed() bool { return e.state.cursorLine == 0 }

func (e *Editor) isAtStartOfMessage() bool {
	if !e.isSlashMenuAllowed() {
		return false
	}
	before := runeSlice(e.curLine(), 0, e.state.cursorCol)
	t := strings.TrimSpace(before)
	return t == "" || t == "/"
}

func (e *Editor) isInSlashCommandContext(before string) bool {
	return e.isSlashMenuAllowed() && strings.HasPrefix(strings.TrimLeft(before, " \t"), "/")
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}
