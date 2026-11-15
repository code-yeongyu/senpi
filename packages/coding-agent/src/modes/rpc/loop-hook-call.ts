import { AsyncLocalStorage } from "node:async_hooks";
import type { LoopHookCallFacts, LoopWakeRoute } from "../../core/extensions/runner.ts";
import type { HistoryReducer } from "../../core/session-history-reduce.ts";
import type { ReadonlySessionManager, SessionEntry } from "../../core/session-manager.ts";

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
}

/** What a loop-hook call binds its handlers' facts to: the loop session's state the call carries. */
export interface LoopHookCallBinding {
	readonly sessionId: string;
	readonly cwd: string;
	/** The loop's idle state the call carries. */
	readonly idle: boolean;
	/** The session port's read half, when the call carries it (an `agent_end` does). */
	readonly carried?: CarriedSession;
	/**
	 * Whether the loop's turn has ended by this call (an `agent_end`): after the call, its work sees the session idle until
	 * the loop starts another call for that session, as a local session is idle after a turn until the next one starts.
	 */
	readonly endsTurn?: boolean;
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
	 * goes to the call's late route (on a hand, a durable wake to the loop), in order.
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
 * Where a call's effects go once that call ended, for its loop session (brain/hand split H3): on a hand, the durable
 * wake outbox, so they reach the loop at least once whether or not the session makes another call, and never through a
 * reply that may be lost. A held Stop's stop-state entries and its block follow-up travel this way too, so a block from
 * an idle loop's Stop wakes that loop. Late work never throws into the user's hook code.
 */
export type LateLoopRoute = (sessionId: string) => LoopWakeRoute;

export function createLoopHookCall(late: LateLoopRoute): LoopHookCall {
	const calls = new AsyncLocalStorage<{ readonly live: () => boolean; readonly facts: LoopHookCallFacts }>();
	// The latest call each loop session started: a newer one means the loop acts on that session again.
	const latest = new Map<string, object>();
	return {
		current: () => {
			const call = calls.getStore();
			return call?.live() === true ? call.facts : undefined;
		},
		sender: () => calls.getStore()?.facts.sendMessage,
		writer: () => calls.getStore()?.facts,
		async run(binding, dispatch) {
			const { sessionId, idle, cancel } = binding;
			const token = {};
			latest.set(sessionId, token);
			let live = true;
			// Whether the loop still reads this call's reply. A cancel ends that: the loop drops the reply, so what the call's
			// work made for it, and makes from then on, goes to the late route as wakes (#6753 review L1). The call itself
			// stays live for its handlers, which keep running until they return.
			let replyRead = true;
			let userMessagesSent = 0;
			const controller = new AbortController();
			const effects: LoopHookEffects = { sent: [], notices: [], entries: [], userMessages: [] };
			// What the reply carries, in the order the work made it (#6808 review L3), as sends to the late route.
			const forReply: ((route: LoopWakeRoute) => void)[] = [];
			const onCancel = () => {
				replyRead = false;
				// First, so a send that fails cannot keep the handlers' signal from aborting (#6808 review L2).
				controller.abort();
				effects.sent.length = 0;
				effects.notices.length = 0;
				effects.entries.length = 0;
				effects.userMessages.length = 0;
				const route = late(sessionId);
				for (const send of forReply.splice(0)) send(route);
			};
			// Kept after the call returns: a cancel that arrives then means the loop host dropped the reply already sent,
			// so its effects go out here instead (#6808 review L1). The hand keeps the signal until the host acknowledges
			// the reply, and a cancel never follows an acknowledged one, so each effect reaches the loop once.
			if (cancel?.aborted === true) onCancel();
			else cancel?.addEventListener("abort", onCancel, { once: true });
			const facts: LoopHookCallFacts = Object.freeze({
				sessionManager: readOnlySession(binding, {
					live: () => live,
					ownWork: () => live || calls.getStore()?.facts === facts,
				}),
				signal: controller.signal,
				isIdle: () => (live || binding.endsTurn !== true ? idle : latest.get(sessionId) === token),
				sendMessage: (message: SentLoopMessage["message"], options?: SentLoopMessage["options"]) => {
					const entry = options === undefined ? { message } : { message, options };
					if (!(live && replyRead)) return late(sessionId).sendMessage(message, options);
					effects.sent.push(entry);
					forReply.push((route) => route.sendMessage(message, options));
				},
				notify: (message: string, type?: Parameters<LoopHookCallFacts["notify"]>[1]) => {
					const entry = type === undefined ? { message } : { message, type };
					if (!(live && replyRead)) return late(sessionId).notify(message, type);
					effects.notices.push(entry);
					forReply.push((route) => route.notify(message, type));
				},
				appendEntry: (customType: string, data?: unknown) => {
					const entry = data === undefined ? { customType } : { customType, data };
					if (!(live && replyRead)) return late(sessionId).appendEntry(customType, data);
					effects.entries.push(entry);
					forReply.push((route) => route.appendEntry(customType, data));
				},
				sendUserMessage: (content: SentLoopUserMessage["content"], options?: SentLoopUserMessage["options"]) => {
					const entry = options === undefined ? { content } : { content, options };
					userMessagesSent++;
					if (!(live && replyRead)) return late(sessionId).sendUserMessage(content, options);
					effects.userMessages.push(entry);
					forReply.push((route) => route.sendUserMessage(content, options));
				},
				// Only what this call (or its work) sent.
				hasPendingMessages: () => userMessagesSent > 0,
			});
			try {
				return await calls.run({ live: () => live, facts }, () => dispatch(effects, controller.signal));
			} finally {
				live = false;
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
 * keeps working: late writes, messages and notices go to the call's late route; the signal stays aborted; idle keeps
 * its value, except that after a call that ended the loop's turn it answers idle until the loop starts another call.
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
