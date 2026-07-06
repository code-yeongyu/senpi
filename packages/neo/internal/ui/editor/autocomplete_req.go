package editor

import (
	"context"
	"regexp"
	"strings"
)

// acRequest tracks a single in-flight context-aware autocomplete request so a
// newer request can cancel it — the Go analogue of the tui AbortController held
// in autocompleteAbort. started closes once the provider goroutine has begun,
// giving tests a deterministic "the request is now in flight" seam.
type acRequest struct {
	gen     uint64
	cancel  context.CancelFunc
	started chan struct{}
}

// triggerPattern builds the regex matching a symbol-completion context ending at
// the cursor, mirroring buildTriggerPattern().
func (e *Editor) triggerPattern() *regexp.Regexp {
	var b strings.Builder
	for _, c := range e.triggerChars {
		b.WriteString(regexp.QuoteMeta(c))
	}
	return regexp.MustCompile(`(?:^|\s)[` + b.String() + `][^\s]*$`)
}

// debouncePattern mirrors buildDebouncePattern(): @-attachments (with optional
// quotes) and other trigger chars trigger the debounce delay.
func (e *Editor) debouncePattern() *regexp.Regexp {
	var b strings.Builder
	for _, c := range e.triggerChars {
		if c == "@" {
			continue
		}
		b.WriteString(regexp.QuoteMeta(c))
	}
	return regexp.MustCompile(`(?:^|[ \t])(?:@(?:"[^"]*|[^\s]*)|[` + b.String() + `][^\s]*)$`)
}

func (e *Editor) tryTriggerAutocomplete() {
	e.requestAutocomplete(false, false)
}

func (e *Editor) handleTabCompletion() {
	if e.provider == nil {
		return
	}
	before := runeSlice(e.curLine(), 0, e.state.cursorCol)
	if e.isInSlashCommandContext(before) && !strings.Contains(strings.TrimLeft(before, " \t"), " ") {
		e.requestAutocomplete(false, true)
	} else {
		e.forceFileAutocomplete(true)
	}
}

func (e *Editor) forceFileAutocomplete(explicitTab bool) {
	e.requestAutocomplete(true, explicitTab)
}

// requestAutocomplete queues or immediately runs an autocomplete request.
// Ported from requestAutocomplete() + startAutocompleteRequest().
func (e *Editor) requestAutocomplete(force, explicitTab bool) {
	if e.provider == nil {
		return
	}
	if force {
		if gate, ok := e.provider.(fileCompletionGate); ok {
			if !gate.ShouldTriggerFileCompletion(e.state.lines, e.state.cursorLine, e.state.cursorCol) {
				return
			}
		}
	}
	e.cancelAutocompleteRequest()

	if e.debounceMs(force, explicitTab) {
		e.pendingDebounce = true
		e.pendingDebounceFn = func() { e.runAutocompleteRequest(force, explicitTab) }
		return
	}
	e.runAutocompleteRequest(force, explicitTab)
}

// debounceMs reports whether the request should be debounced.
func (e *Editor) debounceMs(force, explicitTab bool) bool {
	if explicitTab || force {
		return false
	}
	before := runeSlice(e.curLine(), 0, e.state.cursorCol)
	return e.debouncePattern().MatchString(before)
}

func (e *Editor) runAutocompleteRequest(force, explicitTab bool) {
	if e.provider == nil {
		return
	}
	// Context-aware provider: run the request so it can be aborted by a newer
	// keystroke (tui AbortController path). Sync providers resolve inline.
	if ctxProvider, ok := e.provider.(CtxAutocompleteProvider); ok {
		e.startCtxAutocompleteRequest(ctxProvider, force, explicitTab)
		return
	}
	sugg, err := e.provider.GetSuggestions(e.state.lines, e.state.cursorLine, e.state.cursorCol, force)
	e.finishAutocompleteRequest(sugg, err, force, explicitTab)
}

// startCtxAutocompleteRequest launches a cancellable request against a
// context-aware provider. The provider may block until the context is cancelled
// (a superseding keystroke) or resolves normally; either way the goroutine's
// result is applied only if the request is still current (its generation matches
// and it was not cancelled), mirroring isAutocompleteRequestCurrent().
func (e *Editor) startCtxAutocompleteRequest(p CtxAutocompleteProvider, force, explicitTab bool) {
	e.acRequestGen++
	gen := e.acRequestGen
	ctx, cancel := context.WithCancel(context.Background())
	req := &acRequest{gen: gen, cancel: cancel, started: make(chan struct{})}
	e.acInflight = req

	lines := e.state.lines
	cl, cc := e.state.cursorLine, e.state.cursorCol

	e.acWG.Add(1)
	go func() {
		defer e.acWG.Done()
		close(req.started)
		sugg, err := p.GetSuggestionsCtx(ctx, lines, cl, cc, force)
		// Drop the result if a newer request superseded this one or it was
		// cancelled (the tui checks !signal.aborted && requestId current).
		if ctx.Err() != nil || gen != e.acRequestGen {
			return
		}
		e.acInflight = nil
		e.finishAutocompleteRequest(sugg, err, force, explicitTab)
	}()
}

// finishAutocompleteRequest applies a resolved suggestion set, shared by the sync
// and context-aware paths. Ported from the tail of runAutocompleteRequest().
func (e *Editor) finishAutocompleteRequest(sugg *Suggestions, err error, force, explicitTab bool) {
	if err != nil || sugg == nil || len(sugg.Items) == 0 {
		e.cancelAutocomplete()
		return
	}
	if force && explicitTab && len(sugg.Items) == 1 {
		item := sugg.Items[0]
		e.pushUndo()
		e.lastAction = actionNone
		e.applyResult(e.provider.ApplyCompletion(e.state.lines, e.state.cursorLine, e.state.cursorCol, item, sugg.Prefix))
		e.emitChange()
		return
	}
	state := acRegular
	if force {
		state = acForce
	}
	e.applySuggestions(sugg, state)
}

func (e *Editor) applySuggestions(sugg *Suggestions, state acStateKind) {
	e.acPrefix = sugg.Prefix
	e.acList = newACPopup(sugg.Items, e.acMaxVisible)
	if idx := bestMatchIndex(sugg.Items, sugg.Prefix); idx >= 0 {
		e.acList.setSelected(idx)
	}
	e.acState = state
}

func (e *Editor) applyResult(r ApplyResult) {
	e.state.lines = r.Lines
	e.state.cursorLine = r.CursorLine
	e.setCursorCol(r.CursorCol)
}

// acceptAutocomplete applies the selected suggestion. Returns true when the
// caller should fall through to submit (slash-command Enter path).
func (e *Editor) acceptAutocomplete(isConfirm bool) bool {
	item, ok := e.acList.selectedItem()
	if !ok || e.provider == nil {
		return false
	}
	e.pushUndo()
	e.lastAction = actionNone
	e.applyResult(e.provider.ApplyCompletion(e.state.lines, e.state.cursorLine, e.state.cursorCol, item, e.acPrefix))
	if isConfirm && strings.HasPrefix(e.acPrefix, "/") {
		e.cancelAutocomplete()
		return true // fall through to submit
	}
	e.cancelAutocomplete()
	e.emitChange()
	return false
}

// bestMatchIndex returns the index of the best prefix match. Exact match wins;
// else the first item whose value has prefix; else -1. Ported from
// getBestAutocompleteMatchIndex().
func bestMatchIndex(items []Item, prefix string) int {
	if prefix == "" {
		return -1
	}
	firstPrefix := -1
	for i, it := range items {
		if it.Value == prefix {
			return i
		}
		if firstPrefix == -1 && strings.HasPrefix(it.Value, prefix) {
			firstPrefix = i
		}
	}
	return firstPrefix
}
