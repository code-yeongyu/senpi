import { AsyncLocalStorage } from "node:async_hooks";
import { readOnlySession } from "./loop-hook-session.ts";
import type { LoopHookCallFacts } from "../../core/extensions/runner.ts";
import type { SessionEntry, SessionHeader } from "../../core/session-manager.ts";
import type { SessionWake } from "../../core/session-wakes.ts";
import type { BuildSystemPromptOptions } from "../../core/system-prompt.ts";
import { applyActiveToolsChange } from "../../core/hand/session-effects.ts";
import { collectDocumentChanges, materializeDocuments, type SessionDocuments } from "./session-documents.ts";
import { type CarriedRelocation, carriedRelocationHost, carriedWakePort } from "./session-port-hosts.ts";
import {
	emptyEffects,
	type LoopHookEffects,
	type SentLoopMessage,
	type SentLoopUserMessage,
} from "./loop-hook-effects.ts";

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
	/** The session's documents (`getSessionDir()` stores, see `session-documents.ts`); absent: the session has no directory here. */
	readonly documents?: SessionDocuments;
	/** The loop's pending wakes for the session (`pi.session.sessionWakes()`); absent: wakes stay with this process. */
	readonly wakes?: readonly SessionWake[];
	/** The computers the loop's host offers to continue on (`pi.session` relocation); absent: not offered. */
	readonly relocation?: CarriedRelocation;
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
			const documents = carried?.documents;
			const sessionDir = documents === undefined ? undefined : await materializeDocuments(documents);
			const relocation =
				carried?.relocation === undefined
					? undefined
					: carriedRelocationHost(
							carried.relocation,
							(request) => {
								effects.relocation = request;
							},
							() => live,
						);
			const wakes =
				carried?.wakes === undefined ? undefined : carriedWakePort(carried.wakes, effects.wakes, () => live);
			effects.seal = () => {
				live = false;
			};
			let settling: Promise<void> | undefined;
			effects.settle = () => {
				if (sessionDir === undefined || documents === undefined) return Promise.resolve();
				settling ??= collectDocumentChanges(sessionDir, documents).then((changes) => {
					effects.documents = changes;
				});
				return settling;
			};
			const facts: LoopHookCallFacts = Object.freeze({
				sessionManager: readOnlySession(sessionId, cwd, () => live, { carried, sessionDir }),
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
					const active = carried?.activeTools;
					if (active === undefined) return undefined;
					return effects.activeTools === undefined
						? [...active]
						: applyActiveToolsChange(active, effects.activeTools);
				},
				getSystemPromptOptions: () => ({ ...carried?.systemPromptOptions, cwd }),
				relocationHost: () => relocation,
				sessionWakes: () => wakes,
				// Only a set the loop carried can change: the loop applies the change to that set.
				setActiveTools: (names: readonly string[]) => {
					const active = carried?.activeTools;
					if (!live || active === undefined) return;
					effects.activeTools = {
						activate: names.filter((name, index) => !active.includes(name) && names.indexOf(name) === index),
						deactivate: active.filter((name) => !names.includes(name)),
					};
				},
			});
			try {
				return await calls.run({ live: () => live, facts }, () => dispatch(effects));
			} finally {
				live = false;
				controller.abort();
				// The session directory never outlives the call, also when its work threw before the reply settled it.
				await effects.settle();
			}
		},
	};
}
