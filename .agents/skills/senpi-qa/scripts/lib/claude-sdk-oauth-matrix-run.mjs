/**
 * Matrix run driver: executes one turn on the real stack and records every
 * contract fact the assertions need (queries created, lineage, payload shape,
 * continuity observations), plus the boundary controls each phase needs
 * (injected clock, registry wipe, branch navigation, mid-turn abort).
 */

import { classifyPayload, withTimeout } from "./claude-sdk-oauth-fullstack-support.mjs";
import { MATRIX_TURN_TIMEOUT_MS } from "./claude-sdk-oauth-matrix-constants.mjs";

/** Yields until the macrotask queue is empty — a drain, never a timed wait. */
function drainMacrotasks(rounds = 3) {
	let chain = Promise.resolve();
	for (let round = 0; round < rounds; round += 1) {
		chain = chain.then(() => new Promise((resolve) => setImmediate(resolve)));
	}
	return chain;
}

export class MatrixRun {
	constructor({ stack, session, models, observations }) {
		this.stack = stack;
		this.session = session;
		this.models = models;
		this.observations = observations;
		this.turns = [];
		this.phase = { id: "?", label: "setup" };
		this.currentTurn = null;
		this.clockOffset = 0;
		this.thinkingLevel = "off";
		this.activeModelId = models.primary.id;
	}

	/** Feeds the boundary payload hook; called by the harness for every submitted message. */
	observePayload(entry) {
		if (!this.currentTurn) return;
		this.currentTurn.payloads.push(entry);
		// The payload just entered the SDK query, so the pump's active turn exists
		// and its claim transition can be watched.
		this.currentTurn.watchForClaim?.();
	}

	/**
	 * Fires the mid-turn abort at a provably in-flight moment, with no timing luck
	 * and no dependency cycle:
	 *   1. the loopback response is SPLIT — the opening events (message_start plus
	 *      the first text delta) go out immediately so the CLI claims the turn and
	 *      starts streaming, while the terminating events are HELD back, so the
	 *      turn physically cannot complete;
	 *   2. the abort fires on the session's first `message_update`, which can only
	 *      happen after the CLI consumed those opening events — proof that the turn
	 *      is claimed and the assistant is mid-stream;
	 *   3. the held tail is released only after the abort settles.
	 * Holding the whole response instead would deadlock: the claim is produced by
	 * the CLI, which cannot progress without the opening events.
	 */
	armMidTurnAbort(turn) {
		const sessionId = this.session.sessionManager.getSessionId();
		turn.abortPromise = new Promise((resolve) => {
			let settled = false;
			const fire = (sdkTurn) => {
				if (settled) return;
				settled = true;
				turn.abortFired = true;
				// Snapshot the live turn so the interrupt receipt the REAL CLI returns
				// can be scored by production's own evaluateAbortOutcome.
				turn.activeSdkTurn = sdkTurn;
				// Release only after the abort settles: while the terminating SSE events
				// are held the turn cannot finish, so the interrupt is guaranteed to land
				// on a live turn.
				resolve(
					this.session.abort().finally(() => {
						turn.releaseResponse?.();
					}),
				);
			};
			// The claim is the authoritative "turn is live and streaming" signal, and
			// it is observed as an EVENT: the pump's own `claimed` flag is wrapped in
			// an accessor that fires the abort the moment production sets it. The
			// held tail guarantees the turn cannot complete before that happens, so
			// there is no polling, no sleeping, and no race with turn completion.
			const watched = new WeakSet();
			turn.watchForClaim = () => {
				const sdkTurn = this.stack.registryModule.getSession(sessionId)?.activeTurn;
				if (!sdkTurn || watched.has(sdkTurn) || settled) return;
				watched.add(sdkTurn);
				if (sdkTurn.claimed === true) {
					fire(sdkTurn);
					return;
				}
				let value = sdkTurn.claimed;
				Object.defineProperty(sdkTurn, "claimed", {
					configurable: true,
					get: () => value,
					set: (next) => {
						value = next;
						if (next === true) fire(sdkTurn);
					},
				});
			};
			turn.disarmAbort = () => {
				if (settled) return;
				settled = true;
				turn.releaseResponse?.();
				resolve(undefined);
			};
		});
	}

	beginPhase(phase) {
		this.phase = phase;
	}

	async turn(text, expectations = {}) {
		const stack = this.stack;
		const creationsBefore = stack.creations.length;
		const requestsBefore = stack.providerRequests.length;
		const observationsBefore = this.observations.length;
		const lineageBefore = stack.creations.at(-1)?.lineage ?? null;
		this.currentTurn = { payloads: [], abortFired: false };
		if (expectations.abortMidTurn === true) {
			// Hold the loopback response open so the turn is still streaming when the
			// abort lands; the abort itself releases it.
			this.armMidTurnAbort(this.currentTurn);
			// Hold the terminating events so the turn cannot finish before the abort.
			this.currentTurn.releaseResponse = stack.holdNextResponse();
		}
		let error;
		try {
			await withTimeout(
				this.session.prompt(text, { sessionTitlePrompt: false }),
				`${this.phase.id}/${this.turns.length + 1}`,
				MATRIX_TURN_TIMEOUT_MS,
			);
			// Disarm first: when no abort fired, the armed promise would never settle.
			if (!this.currentTurn.abortFired) this.currentTurn.disarmAbort?.();
			await this.currentTurn.abortPromise;
			await this.session.waitForIdle();
		} catch (cause) {
			error = cause instanceof Error ? cause : new Error(String(cause));
		}
		// The provider generator emits its continuity observation after the prompt
		// settles; drain the macrotask queue so each observation is attributed to the
		// turn that produced it instead of leaking into the next row.
		await drainMacrotasks();
		const created = stack.creations.slice(creationsBefore);
		const payloads = this.currentTurn.payloads.map((entry) => ({
			...entry,
			...classifyPayload(entry.message),
		}));
		const aborted = this.currentTurn;
		this.currentTurn = null;
		const lineage = stack.creations.at(-1)?.lineage ?? lineageBefore;
		const transcriptId = stack.creations.at(-1)?.sessionId ?? null;
		const abortFired = aborted.abortFired === true;
		const abortOutcome = abortFired
			? this.stack.reattachModule.evaluateAbortOutcome(aborted.activeSdkTurn?.interruptReceipt)
			: undefined;
		const turn = {
			phase: this.phase.id,
			abortFired,
			abortOutcome,
			label: this.phase.label,
			index: this.turns.length + 1,
			queries: created.length,
			path: payloads.at(-1)?.path ?? created.at(-1)?.path ?? "none",
			kind: payloads.at(-1)?.kind ?? "none",
			bytes: payloads.reduce((total, item) => total + item.bytes, 0),
			lineage: lineage ?? "none",
			transcriptId: transcriptId ?? "none",
			lineageChanged: lineageBefore !== null && lineage !== lineageBefore,
			forked: created.some((record) => record.forked),
			resumedSameTranscript: created.every((record) => record.resume !== null),
			wireRequests: stack.providerRequests.length - requestsBefore,
			observations: this.observations.slice(observationsBefore),
			completed: expectations.completes !== false && !error,
			expectations,
			error,
		};
		this.turns.push(turn);
		return turn;
	}

	/** Phase (c): switch to the other claude-sdk-oauth model on the same provider. */
	async switchModel() {
		const target = this.activeModelId === this.models.primary.id ? this.models.alternate : this.models.primary;
		const before = this.stack.creations.length;
		await this.session.setModel(target);
		this.activeModelId = target.id;
		if (this.stack.creations.length !== before) {
			throw new Error("model switch created an SDK query outside a turn");
		}
	}

	/** Phase (d): a real thinking-level change, which the wiring turns into a reattach boundary. */
	switchThinkingLevel() {
		this.thinkingLevel = this.thinkingLevel === "medium" ? "low" : "medium";
		this.session.setThinkingLevel(this.thinkingLevel);
	}

	/**
	 * Phase (e): drop every live registry entry, exactly as a process restart
	 * would, so the post-restart turn can only be served by a persisted binding.
	 */
	simulateProcessRestart() {
		const registry = this.stack.registryModule.sessionRegistry;
		const sessionId = this.session.sessionManager.getSessionId();
		if (registry.get(sessionId) === undefined) throw new Error("no live registry entry to isolate");
		registry.closeSession(sessionId, "session_shutdown");
		if (registry.get(sessionId) !== undefined) throw new Error("registry entry survived the simulated restart");
	}

	/** Phase (g): move the leaf back N completed user turns. */
	navigateBackUserTurns(count) {
		const userMessages = this.session.getUserMessagesForForking();
		const target = userMessages.at(-(count + 1));
		if (!target) throw new Error(`cannot navigate back ${count} turns: only ${userMessages.length} user turns`);
		return this.session.navigateTree(target.entryId);
	}

	/** Phase (h): advance the injected registry clock past the idle TTL — no sleeping. */
	advanceRegistryClock(deltaMs) {
		this.clockOffset += deltaMs;
		const offset = () => this.clockOffset;
		this.stack.registryModule.overrideSessionRegistryBoundary({ now: () => Date.now() + offset() });
	}
}
