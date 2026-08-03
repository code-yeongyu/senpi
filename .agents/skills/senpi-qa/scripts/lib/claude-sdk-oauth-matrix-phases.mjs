/**
 * Scenario phases for the claude-sdk-oauth continuity matrix.
 *
 * Every phase drives the REAL stack (AgentSession.prompt -> provider ->
 * resident registry) and declares the query-creation budget it is allowed to
 * spend, so a regression that re-creates a query per turn fails its own phase.
 *
 * No sleeps anywhere: boundaries are driven by completion promises, by the
 * injected registry clock, and by hooks that fire when a payload reaches the
 * SDK boundary.
 */

import { SESSION_REGISTRY_IDLE_TTL_MS } from "./claude-sdk-oauth-matrix-constants.mjs";

/**
 * Phase (a): a plain 6-turn conversation must cost EXACTLY ONE SDK query in
 * total (the bootstrap). A per-turn `query({resume: sameId})` regression
 * spends 6 and fails here.
 */
export async function phasePlainConversation(run) {
	for (let index = 1; index <= 6; index += 1) {
		await run.turn(`Turn ${index}: reply with TOKEN_T${index}.`, {
			expectQueries: index === 1 ? 1 : 0,
			expectLineage: index === 1 ? "new" : "same",
		});
	}
}

/**
 * Phase (b): abort mid-turn. The abort is armed the instant the turn's payload
 * reaches the SDK boundary — that is genuinely mid-turn and needs no timer.
 * Budget depends on the interrupt receipt the real CLI returns:
 * `still_queued: []` keeps the live query (0 new), anything else closes the
 * session and the NEXT turn reattaches on the SAME id (1 new).
 */
export async function phaseAbortMidTurn(run) {
	await run.turn("Turn A1: reply with TOKEN_A1.", { expectQueries: 0, expectLineage: "same" });
	const aborted = await run.turn("Turn A2: this turn is aborted mid-flight.", {
		abortMidTurn: true,
		expectQueries: 0,
		expectLineage: "same",
	});
	if (!aborted.abortFired) throw new Error("phase (b) never reached a mid-turn abort");
	// The budget is read from the receipt the REAL CLI returned, not guessed:
	// keep => the live query serves the next turn (0), reattach => exactly 1 on
	// the same lineage. Either way a flatten or a new lineage is a failure.
	await run.turn("Turn A3: reply with TOKEN_A3.", {
		expectQueries: aborted.abortOutcome === "keep" ? 0 : 1,
		expectLineage: "same",
	});
}

/**
 * Phase (c): same-provider model switch. The plan's rule is spike-conditioned:
 * 0 new queries only if spike-2 proved the SDK's setModel keeps the turn stream
 * intact, else exactly 1 same-ID reattach. Spike-2 is PENDING (no live run), so
 * the declared fallback applies and the budget is exactly 1 reattach on the
 * SAME lineage — never a fork, never a flatten. `switchSessionModel` does call
 * the SDK setModel in place, but a model change also moves the options
 * fingerprint, so continuity resolves through a same-lineage reattach.
 */
export async function phaseModelSwitch(run) {
	await run.switchModel();
	await run.turn("Turn C1: reply with TOKEN_C1 after the model switch.", {
		expectQueries: 1,
		expectLineage: "same",
	});
}

/**
 * Phase (d): thinking-level switch always closes the entry keeping the binding
 * (session-registry-wiring.ts), so the next turn is a reattach boundary:
 * exactly 1 new query on the SAME sdkSessionId.
 */
export async function phaseThinkingSwitch(run) {
	run.switchThinkingLevel();
	await run.turn("Turn D1: reply with TOKEN_D1 after the thinking switch.", {
		expectQueries: 1,
		expectLineage: "same",
	});
}

/**
 * Phase (e): process-restart isolation. The module-global session registry is
 * wiped (every live entry closed and dropped) before the post-restart turn, so
 * a still-live in-memory entry cannot satisfy the assertions — only the
 * persisted continuity binding can. Reattach boundary: 1 query, SAME id.
 */
export async function phaseRestartIsolation(run) {
	run.simulateProcessRestart();
	await run.turn("Turn E1: reply with TOKEN_E1 after the restart.", {
		expectQueries: 1,
		expectLineage: "same",
	});
}

/**
 * Phase (g): navigate the branch back 2 turns, then prompt again. The rolled
 * back history diverges from what the lineage already sent, so continuity
 * resolves to a fork: exactly 1 new query on a NEW sdkSessionId.
 */
export async function phaseBranchNavigation(run) {
	run.navigateBackUserTurns(2);
	await run.turn("Turn G1: reply with TOKEN_G1 on the new branch.", {
		expectQueries: 1,
		expectLineage: "fork",
	});
}

/**
 * Phase (h): idle expiry forced through the injected registry clock — the TTL
 * elapses between turns with zero wall-clock waiting. The next turn MUST
 * reattach the SAME lineage: 1 new query, same sdkSessionId, never a flatten.
 */
export async function phaseIdleExpiry(run) {
	run.advanceRegistryClock(SESSION_REGISTRY_IDLE_TTL_MS + 60_000);
	await run.turn("Turn H1: reply with TOKEN_H1 after the idle TTL elapsed.", {
		expectQueries: 1,
		expectLineage: "same",
	});
}

export const MATRIX_PHASES = [
	{ id: "a", label: "plain-6-turn", run: phasePlainConversation },
	{ id: "b", label: "abort-mid-turn", run: phaseAbortMidTurn },
	{ id: "c", label: "model-switch", run: phaseModelSwitch },
	{ id: "d", label: "thinking-switch", run: phaseThinkingSwitch },
	{ id: "e", label: "restart-isolation", run: phaseRestartIsolation },
	{
		id: "f",
		label: "compaction-fill",
		skip: "senpi compaction is disabled for this lane (todo 13: SDK-native auto-compaction owns it) and the loopback server cannot make the real CLI emit a compact_boundary; faking one would assert nothing about production",
	},
	{ id: "g", label: "branch-navigation", run: phaseBranchNavigation },
	{ id: "h", label: "idle-expiry", run: phaseIdleExpiry },
	{
		id: "i",
		label: "failover-injection",
		skip: "multi-account rotation needs the managed oauth-slots lane, which strips ANTHROPIC_BASE_URL from the subprocess env (auth-lane.ts managedEnvironment) and would leave the hermetic loopback; the ambient lane this probe runs on has no second slot to rotate to",
	},
];
