import { AsyncLocalStorage } from "node:async_hooks";
import type { LoopHookCallFacts } from "../../core/extensions/runner.ts";
import type { HistoryReducer } from "../../core/session-history-reduce.ts";
import type { ReadonlySessionManager, SessionEntry, SessionHeader } from "../../core/session-manager.ts";
import type { BuildSystemPromptOptions } from "../../core/system-prompt.ts";

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
	/**
	 * The branch a hand reads (`getBranch`, `getEntries`), in branch order, after the last compaction: this hand's entries
	 * and the user's messages (a todo list's ask reads the request it answers). Absent: the hand's entries alone.
	 */
	readonly branch?: readonly SessionEntry[];
	/** The loop session's header (`getHeader`); absent: it stays loop-side. */
	readonly header?: SessionHeader;
	/** The loop's active tool names (`pi.getActiveTools()`); absent: the active set stays loop-side and unchangeable. */
	readonly activeTools?: readonly string[];
	/** The loop's system prompt options a call reads (its `surface`, ...); only `cwd` is this machine's own. */
	readonly systemPromptOptions?: Readonly<Partial<BuildSystemPromptOptions>>;
}

/** What a loop-hook call's handlers did beyond their result, which the loop does in turn (session port, write). */
export interface LoopHookEffects {
	readonly sent: SentLoopMessage[];
	readonly notices: LoopNotice[];
	readonly entries: AppendedLoopEntry[];
	readonly userMessages: SentLoopUserMessage[];
	/** The active tool set the call's work left, for the loop to apply (`pi.setActiveTools`); unset: unchanged. */
	activeTools: string[] | undefined;
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
	/** The call's session writes (`appendEntry`, `sendUserMessage`) for its work, routed like {@link sender}. */
	writer(): Pick<LoopHookCallFacts, "appendEntry" | "sendUserMessage"> | undefined;
	/** Runs `dispatch` as the call, with the loop's idle state; `effects` collects what its handlers send and notify. */
	run<T>(
		sessionId: string,
		cwd: string,
		idle: boolean,
		dispatch: (effects: LoopHookEffects) => Promise<T>,
		carried?: CarriedSession,
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
		const held = late.get(sessionId) ?? emptyEffects();
		add(held);
		while (
			held.sent.length + held.notices.length + held.entries.length + held.userMessages.length >
			LATE_PER_SESSION
		) {
			// Notices only reach the loop's UI, messages reach its model, so the oldest notice goes first.
			const oldest = [held.notices, held.entries, held.sent, held.userMessages].find((list) => list.length > 0);
			oldest?.shift();
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
		writer: () => calls.getStore()?.facts,
		async run(sessionId, cwd, idle, dispatch, carried) {
			let live = true;
			const controller = new AbortController();
			const effects: LoopHookEffects = late.get(sessionId) ?? emptyEffects();
			late.delete(sessionId);
			const facts: LoopHookCallFacts = Object.freeze({
				sessionManager: readOnlySession(sessionId, cwd, () => live, carried),
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
				appendEntry: (customType: string, data?: unknown) => {
					const entry = data === undefined ? { customType } : { customType, data };
					if (live) effects.entries.push(entry);
					else holdLate(sessionId, (held) => held.entries.push(entry));
				},
				sendUserMessage: (content: SentLoopUserMessage["content"], options?: SentLoopUserMessage["options"]) => {
					const entry = options === undefined ? { content } : { content, options };
					if (live) effects.userMessages.push(entry);
					else holdLate(sessionId, (held) => held.userMessages.push(entry));
				},
				hasPendingMessages: () => effects.userMessages.length > 0,
				getActiveTools: () => {
					const active = effects.activeTools ?? carried?.activeTools;
					return active === undefined ? undefined : [...active];
				},
				getSystemPromptOptions: () => ({ ...carried?.systemPromptOptions, cwd }),
				// Only a set the loop carried can change: the loop applies the change to that set.
				setActiveTools: (names: readonly string[]) => {
					if (live && carried?.activeTools !== undefined) effects.activeTools = [...names];
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

const emptyEffects = (): LoopHookEffects => ({
	sent: [],
	notices: [],
	entries: [],
	userMessages: [],
	activeTools: undefined,
	dropped: 0,
});

/** The effects a reply carries back to the loop, each only when there is one. */
export function effectsReply(effects: LoopHookEffects): Record<string, unknown> {
	const { sent, notices, entries, userMessages, activeTools, dropped } = effects;
	return {
		...(sent.length > 0 ? { sent } : {}),
		...(notices.length > 0 ? { notices } : {}),
		...(entries.length > 0 ? { entries } : {}),
		...(userMessages.length > 0 ? { userMessages } : {}),
		...(activeTools === undefined ? {} : { activeTools }),
		...(dropped > 0 ? { droppedLate: dropped } : {}),
	};
}

function readOnlySession(
	sessionId: string,
	cwd: string,
	live: () => boolean,
	carried: CarriedSession | undefined,
): ReadonlySessionManager {
	const bound =
		<T>(member: string, read: () => T) =>
		(): T => {
			if (!live()) throw new LoopHookCallEndedError(`sessionManager.${member}`);
			return read();
		};
	const header = carried?.header;
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
		getLeafId: carried === undefined ? unbound("getLeafId") : bound("getLeafId", () => carried.leafId),
		getLeafEntry: unbound("getLeafEntry"),
		getEntry: unbound("getEntry"),
		getLabel: unbound("getLabel"),
		getBranch:
			carried === undefined
				? unbound("getBranch")
				: bound("getBranch", () => [...(carried.branch ?? carried.handEntries)]),
		getFullBranch: unbound("getFullBranch"),
		buildContextEntries: unbound("buildContextEntries"),
		buildSessionContext: unbound("buildSessionContext"),
		buildSessionProjection: unbound("buildSessionProjection"),
		getHeader: header === undefined ? unbound("getHeader") : bound("getHeader", () => ({ ...header })),
		getEntries:
			carried === undefined
				? unbound("getEntries")
				: bound("getEntries", () => [...(carried.branch ?? carried.handEntries)]),
		reduceHistory:
			carried === undefined
				? unbound("reduceHistory")
				: <T>(reducer: HistoryReducer<T>): T =>
						bound("reduceHistory", () => carried.handEntries.reduce(reducer.add, reducer.initial()))(),
		getTree: unbound("getTree"),
		getSessionName: unbound("getSessionName"),
	});
}
