import { AsyncLocalStorage } from "node:async_hooks";
import { readOnlySession } from "./loop-hook-session.ts";
import type { LoopHookCallFacts, LoopWakeRoute } from "../../core/extensions/runner.ts";
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
	/** Runs `dispatch` as the call bound to `binding`; `effects` collects what its handlers send, notify and write. */
	run<T>(binding: LoopHookCallBinding, dispatch: (effects: LoopHookEffects) => Promise<T>): Promise<T>;
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
			const { sessionId, cwd, idle, carried } = binding;
			const token = {};
			latest.set(sessionId, token);
			let live = true;
			let userMessagesSent = 0;
			const controller = new AbortController();
			const effects: LoopHookEffects = emptyEffects();
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
				sessionManager: readOnlySession(binding, sessionDir, {
					live: () => live,
					ownWork: () => live || calls.getStore()?.facts === facts,
				}),
				signal: controller.signal,
				isIdle: () => (live || binding.endsTurn !== true ? idle : latest.get(sessionId) === token),
				sendMessage: (message: SentLoopMessage["message"], options?: SentLoopMessage["options"]) => {
					const entry = options === undefined ? { message } : { message, options };
					if (live) effects.sent.push(entry);
					else late(sessionId).sendMessage(message, options);
				},
				notify: (message: string, type?: Parameters<LoopHookCallFacts["notify"]>[1]) => {
					const entry = type === undefined ? { message } : { message, type };
					if (live) effects.notices.push(entry);
					else late(sessionId).notify(message, type);
				},
				appendEntry: (customType: string, data?: unknown) => {
					const entry = data === undefined ? { customType } : { customType, data };
					if (live) effects.entries.push(entry);
					else late(sessionId).appendEntry(customType, data);
				},
				sendUserMessage: (content: SentLoopUserMessage["content"], options?: SentLoopUserMessage["options"]) => {
					const entry = options === undefined ? { content } : { content, options };
					userMessagesSent++;
					if (live) effects.userMessages.push(entry);
					else late(sessionId).sendUserMessage(content, options);
				},
				// Only what this call (or its work) sent.
				hasPendingMessages: () => userMessagesSent > 0,
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
