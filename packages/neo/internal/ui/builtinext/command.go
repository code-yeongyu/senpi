package builtinext

// CommandOutcome is the decision a builtin extension's registerCommand handler
// reaches before touching the UI: either open its overlay, or emit a single
// notify() with a message + level. This is the native port of the decision
// layer inside history-search/index.ts and session-observer/index.ts — the seam
// the classic TS integration tests exercise (no session messages emitted; the
// no-UI/empty paths notify instead of opening; the non-empty path opens exactly
// once). Neo's app shell consumes an outcome to decide whether to push the
// overlay or surface a status notice; the resolvers stay pure so the decision is
// unit-testable without an interactive session.
type CommandOutcome struct {
	// OpenOverlay is true when the handler should open its overlay/picker.
	OpenOverlay bool
	// NotifyMessage is the status notice to emit when OpenOverlay is false. An
	// empty string means no notice (the open path).
	NotifyMessage string
	// NotifyLevel mirrors the classic ctx.ui.notify severity ("info" | "error").
	NotifyLevel string
}

// ResolveHistoryCommandOutcome mirrors history-search/index.ts:28-46: with no UI
// it notifies "No UI available"; with an empty index it notifies "No prompt
// history found"; otherwise it opens the search overlay. (The error branch —
// "Failed to read prompt history: <msg>" — is surfaced by the caller when
// IndexSessions returns an error, before this resolver is reached.)
func ResolveHistoryCommandOutcome(hasUI bool, entries []HistoryEntry) CommandOutcome {
	if !hasUI {
		return CommandOutcome{NotifyMessage: "No UI available", NotifyLevel: "info"}
	}
	if len(entries) == 0 {
		return CommandOutcome{NotifyMessage: "No prompt history found", NotifyLevel: "info"}
	}
	return CommandOutcome{OpenOverlay: true}
}

// ResolveSessionsCommandOutcome mirrors session-observer/index.ts:12-34: with no
// UI it notifies "No UI available"; with no discovered sessions it notifies "No
// sessions found"; otherwise it opens the HUD picker (the classic
// getCustomCallCount()===1 path). (The scan-error branch — "Failed to read
// sessions: <msg>" — is surfaced by the caller when ScanSessionHudEntries
// returns an error, before this resolver is reached.)
func ResolveSessionsCommandOutcome(hasUI bool, sessions []SessionHudEntry) CommandOutcome {
	if !hasUI {
		return CommandOutcome{NotifyMessage: "No UI available", NotifyLevel: "info"}
	}
	if len(sessions) == 0 {
		return CommandOutcome{NotifyMessage: "No sessions found", NotifyLevel: "info"}
	}
	return CommandOutcome{OpenOverlay: true}
}
