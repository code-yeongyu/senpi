import { AsyncLocalStorage } from "node:async_hooks";
import type { LoopHookCallFacts } from "../../core/extensions/runner.ts";
import type { HistoryReducer } from "../../core/session-history-reduce.ts";
import type { ReadonlySessionManager, SessionEntry } from "../../core/session-manager.ts";
import { createSessionTurns } from "./loop-hook-session-turns.ts";

/** A message a loop hook sent during its call, for the loop to send with the same options. */
export interface SentLoopMessage {
	readonly message: Parameters<LoopHookCallFacts["sendMessage"]>[0];
	readonly options?: Parameters<LoopHookCallFacts["sendMessage"]>[1];
}

/** An entry a loop hook appended during its call, for the loop to append to its own session (session port, write). */
export interface AppendedLoopEntry {
	readonly customType: string;
	readonly data?: unknown;
}

/** A user message a loop hook sent during its call, for the loop to send with the same options (session port, write). */
export interface SentLoopUserMessage {
	readonly content: Parameters<LoopHookCallFacts["sendUserMessage"]>[0];
	readonly options?: Parameters<LoopHookCallFacts["sendUserMessage"]>[1];
}

/**
 * The session port's read half (r3 N2): the loop facts a call carries beyond the session's id. The loop owns the
 * session; it sends its current leaf and the entries THIS hand authored earlier in the session (the ones it appended
 * from {@link LoopHookEffects.entries}), after the last compaction only. A hand never sees entries the loop authored.
 */
export interface CarriedSession {
	readonly leafId: string | null;
	readonly handEntries: readonly SessionEntry[];
}

/** What a loop-hook call's handlers did beyond their result, which the loop does in turn (session port, write). */
export interface LoopHookEffects {
	readonly sent: SentLoopMessage[];
	readonly notices: LoopNotice[];
	readonly entries: AppendedLoopEntry[];
	readonly userMessages: SentLoopUserMessage[];
	/** Late effects (of any kind) dropped because the loop session already held {@link LATE_PER_SESSION}. */
	dropped: number;
}

/**
 * What a forwarded call proves about its loop session's turn (#6770 review M1): `"ended"` (an `agent_end`) or
 * `"running"` (any event that only arrives while a turn runs). Each served event is classified in `TURN_EVIDENCE`.
 */
export type LoopTurnEvidence = "ended" | "running";

/** What a loop-hook call binds its handlers' facts to: the loop session's state the call carries. */
export interface LoopHookCallBinding {
	readonly sessionId: string;
	readonly cwd: string;
	/** The loop's idle state the call carries. */
	readonly idle: boolean;
	/** The session port's read half, when the call carries it (an `agent_end` does). */
	readonly carried?: CarriedSession;
	/**
	 * What the call proves about the session's turn. After an `"ended"` call, work that holds it (`holdIdle`) sees the
	 * session idle until a `"running"` call for it starts, as a local session is idle after a turn until the next starts.
	 */
	readonly turn?: LoopTurnEvidence;
	/** Aborts when the loop cancels the call (its caller stopped waiting); the call's own signal then aborts. */
	readonly cancel?: AbortSignal;
}

/** A notice a loop hook showed during its call, for the loop to show on its own UI. */
export interface LoopNotice {
	readonly message: string;
	readonly type?: Parameters<LoopHookCallFacts["notify"]>[1];
}

/**
 * The loop facts a hand's runner sees during one loop-hook call (S33): the loop session's id, read-only (no transcript
 * path: the transcript lives where the loop runs), the session port (the read half the call carries, and writes the
 * loop applies to its own session: `appendEntry`, `sendUserMessage`), the call's own abort signal, and idle (a
 * forwarded `before_agent_start` starts a turn from idle). Outside the call no loop-side member is bound. After the call
 * ended, its work keeps what {@link LoopHookCallEndedError} lists; the session's identity is bound to the call only.
 */
export interface LoopHookCall {
	/** The facts of the loop-hook call in progress in this async context; none outside one. */
	current(): LoopHookCallFacts | undefined;
	/**
	 * The sender of the call whose work runs in this async context, also after that call ended: a message sent then
	 * travels with the next reply for the same loop session (the link has no other way back), in order.
	 */
	sender(): LoopHookCallFacts["sendMessage"] | undefined;
	/** The call's session writes (`appendEntry`, `sendUserMessage`) for its work, routed like {@link sender}. */
	writer(): Pick<LoopHookCallFacts, "appendEntry" | "sendUserMessage"> | undefined;
	/**
	 * Runs `dispatch` as the call bound to `binding`; `effects` collects what its handlers send, notify and write, and
	 * `signal` is the call's own, aborted when the loop cancels the call or the call ends.
	 */
	run<T>(
		binding: LoopHookCallBinding,
		dispatch: (effects: LoopHookEffects, signal: AbortSignal) => Promise<T>,
	): Promise<T>;
}

/**
 * Effects (messages, notices, entries, user messages) from a call's work after that call ended, which one loop session
 * holds until its next reply: the loop-hook link has no hand-to-loop push yet (senpi#5778), so while the loop is idle
 * they wait for the next call it forwards (for an idle session, the user's next prompt). Past this many, one held
 * effect is dropped per overflow and counted in that reply, by kind in this order: the oldest notice (it reaches only
 * the loop's UI), then the oldest message, then the oldest user message, and an entry only when nothing else is held
 * (entries are session state: a dropped `senpi.hooks.stop-state` would lower the Stop reentry count). Late work never
 * throws into the user's hook code.
 */
export const LATE_PER_SESSION = 256;

export function createLoopHookCall(): LoopHookCall {
	const calls = new AsyncLocalStorage<{ readonly live: () => boolean; readonly facts: LoopHookCallFacts }>();
	const late = new Map<string, LoopHookEffects>();
	const holdLate = (sessionId: string, add: (held: LoopHookEffects) => void) => {
		const held = late.get(sessionId) ?? emptyEffects();
		add(held);
		while (
			held.sent.length + held.notices.length + held.entries.length + held.userMessages.length >
			LATE_PER_SESSION
		) {
			const oldest = [held.notices, held.sent, held.userMessages, held.entries].find((list) => list.length > 0);
			oldest?.shift();
			held.dropped++;
		}
		late.set(sessionId, held);
	};
	const turns = createSessionTurns();
	return {
		current: () => {
			const call = calls.getStore();
			return call?.live() === true ? call.facts : undefined;
		},
		sender: () => calls.getStore()?.facts.sendMessage,
		writer: () => calls.getStore()?.facts,
		async run(binding, dispatch) {
			const { sessionId, idle, cancel } = binding;
			if (binding.turn === "running") turns.running(sessionId);
			// Taken when the call starts, so a turn seen running while this call still runs wins (#6770 review L2).
			const turnEnd = binding.turn === "ended" ? turns.ending(sessionId) : undefined;
			let idleHolds = 0;
			let live = true;
			let userMessagesSent = 0;
			const controller = new AbortController();
			const onCancel = () => controller.abort();
			if (cancel?.aborted === true) controller.abort();
			else cancel?.addEventListener("abort", onCancel, { once: true });
			const effects: LoopHookEffects = late.get(sessionId) ?? emptyEffects();
			late.delete(sessionId);
			const facts: LoopHookCallFacts = Object.freeze({
				sessionManager: readOnlySession(binding, {
					live: () => live,
					ownWork: () => live || calls.getStore()?.facts === facts,
				}),
				signal: controller.signal,
				isIdle: () => (live || idleHolds === 0 || turnEnd === undefined ? idle : turnEnd.idle()),
				holdIdle: () => {
					if (turnEnd === undefined) return () => {};
					const release = turnEnd.hold();
					idleHolds++;
					let held = true;
					return () => {
						if (!held) return;
						held = false;
						idleHolds--;
						release();
					};
				},
				sendMessage: (message: SentLoopMessage["message"], options?: SentLoopMessage["options"]) => {
					const entry = options === undefined ? { message } : { message, options };
					if (live) effects.sent.push(entry);
					else holdLate(sessionId, (held) => held.sent.push(entry));
				},
				notify: (message: string, type?: Parameters<LoopHookCallFacts["notify"]>[1]) => {
					const entry = type === undefined ? { message } : { message, type };
					if (live) effects.notices.push(entry);
					else holdLate(sessionId, (held) => held.notices.push(entry));
				},
				appendEntry: (customType: string, data?: unknown) => {
					const entry = data === undefined ? { customType } : { customType, data };
					if (live) effects.entries.push(entry);
					else holdLate(sessionId, (held) => held.entries.push(entry));
				},
				sendUserMessage: (content: SentLoopUserMessage["content"], options?: SentLoopUserMessage["options"]) => {
					const entry = options === undefined ? { content } : { content, options };
					userMessagesSent++;
					if (live) effects.userMessages.push(entry);
					else holdLate(sessionId, (held) => held.userMessages.push(entry));
				},
				// Only what this call (or its work) sent: late user messages of earlier calls ride its reply but are not its own.
				hasPendingMessages: () => userMessagesSent > 0,
			});
			try {
				return await calls.run({ live: () => live, facts }, () => dispatch(effects, controller.signal));
			} finally {
				live = false;
				turnEnd?.callEnded();
				cancel?.removeEventListener("abort", onCancel);
				controller.abort();
			}
		},
	};
}

/**
 * The deliberate refusal after a loop-hook call ended (option A): the loop session's identity (`getSessionId`,
 * `getSessionFile`, `getCwd`) is bound to that call only, so reading it from a kept context afterwards throws this
 * instead of answering. The session the call carried (`getLeafId`, `reduceHistory`) stays readable by the call's own
 * work (its async context: a Stop it held for background work), and refused from any other context. Every other member
 * keeps working: late writes, messages and notices ride the session's next reply; the signal stays aborted; idle keeps
 * its value, except for work that holds a turn-ending call's idleness (`holdIdle`): it answers idle until a forwarded
 * event proves a turn of the session is running.
 */
export class LoopHookCallEndedError extends Error {
	override readonly name = "LoopHookCallEndedError";
	/** The member that was read, e.g. `sessionManager.getSessionId`. */
	readonly member: string;
	constructor(member: string) {
		super(`this loop-hook call has ended; ${member} is bound to that call only`);
		this.member = member;
	}
}

const emptyEffects = (): LoopHookEffects => ({ sent: [], notices: [], entries: [], userMessages: [], dropped: 0 });

function readOnlySession(
	{ sessionId, cwd, carried }: LoopHookCallBinding,
	gates: { readonly live: () => boolean; readonly ownWork: () => boolean },
): ReadonlySessionManager {
	const gated =
		(open: () => boolean) =>
		<T>(member: string, read: () => T) =>
		(): T => {
			if (!open()) throw new LoopHookCallEndedError(`sessionManager.${member}`);
			return read();
		};
	const bound = gated(gates.live);
	const durable = gated(gates.ownWork);
	const unbound = (member: string) => (): never => {
		throw new Error(
			`sessionManager.${member} is loop-side: a loop-hook call on a hand carries only the session's id`,
		);
	};
	return Object.freeze({
		getSessionId: bound("getSessionId", () => sessionId),
		getSessionFile: bound("getSessionFile", (): string | undefined => undefined),
		getCwd: bound("getCwd", () => cwd),
		getSessionDir: unbound("getSessionDir"),
		getLeafId: carried === undefined ? unbound("getLeafId") : durable("getLeafId", () => carried.leafId),
		getLeafEntry: unbound("getLeafEntry"),
		getEntry: unbound("getEntry"),
		getLabel: unbound("getLabel"),
		getBranch: unbound("getBranch"),
		getFullBranch: unbound("getFullBranch"),
		buildContextEntries: unbound("buildContextEntries"),
		buildSessionContext: unbound("buildSessionContext"),
		buildSessionProjection: unbound("buildSessionProjection"),
		getHeader: unbound("getHeader"),
		getEntries: unbound("getEntries"),
		reduceHistory:
			carried === undefined
				? unbound("reduceHistory")
				: <T>(reducer: HistoryReducer<T>): T =>
						durable("reduceHistory", () => carried.handEntries.reduce(reducer.add, reducer.initial()))(),
		getTree: unbound("getTree"),
		getSessionName: unbound("getSessionName"),
	});
}
