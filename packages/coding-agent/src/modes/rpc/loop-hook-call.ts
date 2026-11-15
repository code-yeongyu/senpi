import { AsyncLocalStorage } from "node:async_hooks";
import type { LoopHookCallFacts } from "../../core/extensions/runner.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import { SessionUnavailableError } from "../../core/session-unavailable.ts";

/** A message a loop hook sent during its call, for the loop to send with the same options. */
export interface SentLoopMessage {
	readonly message: Parameters<LoopHookCallFacts["sendMessage"]>[0];
	readonly options?: Parameters<LoopHookCallFacts["sendMessage"]>[1];
}

/** What a loop-hook call's handlers did beyond their result, which the loop does in turn. */
export interface LoopHookEffects {
	readonly sent: SentLoopMessage[];
	readonly notices: LoopNotice[];
	/** Late messages and notices dropped because the loop session already held {@link LATE_PER_SESSION}. */
	dropped: number;
}

/** A notice a loop hook showed during its call, for the loop to show on its own UI. */
export interface LoopNotice {
	readonly message: string;
	readonly type?: Parameters<LoopHookCallFacts["notify"]>[1];
}

/**
 * The loop facts a hand's runner sees during one loop-hook call, and only during it (S33): the loop session's id,
 * read-only (no transcript path, since the transcript lives where the loop runs, and nothing writes), the call's own
 * abort signal, and idle (a forwarded `before_agent_start` starts a turn from idle). Outside the call, and after it
 * ended even through a captured reference, every loop-side member is unbound again.
 */
export interface LoopHookCall {
	/** The facts of the loop-hook call in progress in this async context; none outside one. */
	current(): LoopHookCallFacts | undefined;
	/**
	 * The sender of the call whose work runs in this async context, also after that call ended: a message sent then
	 * travels with the next reply for the same loop session (the link has no other way back), in order.
	 */
	sender(): LoopHookCallFacts["sendMessage"] | undefined;
	/** Runs `dispatch` as the call, with the loop's idle state; `effects` collects what its handlers send and notify. */
	run<T>(
		sessionId: string,
		cwd: string,
		idle: boolean,
		dispatch: (effects: LoopHookEffects) => Promise<T>,
	): Promise<T>;
}

/**
 * Messages and notices from a call's work after that call ended, which one loop session holds until its next reply
 * (the loop-hook link has no hand-to-loop push). Past this many the oldest held notice is dropped, or the oldest
 * message when no notice is held, and counted in that reply:
 * late work never throws into the user's hook code.
 */
export const LATE_PER_SESSION = 256;

export function createLoopHookCall(): LoopHookCall {
	const calls = new AsyncLocalStorage<{ readonly live: () => boolean; readonly facts: LoopHookCallFacts }>();
	const late = new Map<string, LoopHookEffects>();
	const holdLate = (sessionId: string, add: (held: LoopHookEffects) => void) => {
		const held = late.get(sessionId) ?? { sent: [], notices: [], dropped: 0 };
		add(held);
		while (held.sent.length + held.notices.length > LATE_PER_SESSION) {
			// Notices only reach the loop's UI, messages reach its model, so the oldest notice goes first.
			(held.notices.length > 0 ? held.notices : held.sent).shift();
			held.dropped++;
		}
		late.set(sessionId, held);
	};
	return {
		current: () => {
			const call = calls.getStore();
			return call?.live() === true ? call.facts : undefined;
		},
		sender: () => calls.getStore()?.facts.sendMessage,
		async run(sessionId, cwd, idle, dispatch) {
			let live = true;
			const controller = new AbortController();
			const effects: LoopHookEffects = late.get(sessionId) ?? { sent: [], notices: [], dropped: 0 };
			late.delete(sessionId);
			const facts: LoopHookCallFacts = Object.freeze({
				sessionManager: readOnlySession(sessionId, cwd, () => live),
				signal: controller.signal,
				isIdle: () => idle,
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
			});
			try {
				return await calls.run({ live: () => live, facts }, () => dispatch(effects));
			} finally {
				live = false;
				controller.abort();
			}
		},
	};
}

/**
 * The one deliberate refusal after a loop-hook call ended (option A): the loop session's identity is bound to that call
 * only, so reading it from a kept context afterwards throws this instead of answering. Every other member a call binds
 * keeps working after it (late messages and notices ride the next reply; idle and signal keep their values).
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

function readOnlySession(sessionId: string, cwd: string, live: () => boolean): ReadonlySessionManager {
	const bound =
		<T>(member: string, read: () => T) =>
		(): T => {
			if (!live()) throw new LoopHookCallEndedError(`sessionManager.${member}`);
			return read();
		};
	// A call carries the session's identity, never its record: the record stays loop-side.
	const unbound = (member: string) => (): never => {
		throw new SessionUnavailableError("session_record_unavailable", `sessionManager.${member}`);
	};
	return Object.freeze({
		getSessionId: bound("getSessionId", () => sessionId),
		getSessionFile: bound("getSessionFile", (): string | undefined => undefined),
		getCwd: bound("getCwd", () => cwd),
		getSessionDir: unbound("getSessionDir"),
		getLeafId: unbound("getLeafId"),
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
		reduceHistory: unbound("reduceHistory"),
		getTree: unbound("getTree"),
		getSessionName: unbound("getSessionName"),
	});
}
