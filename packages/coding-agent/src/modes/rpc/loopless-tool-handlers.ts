import { AsyncLocalStorage } from "node:async_hooks";
import type { ImageContent, JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionRunner, LoopHookCallFacts } from "../../core/extensions/runner.ts";
import type { BeforeAgentStartEvent, InputAttribution, InputSource } from "../../core/extensions/types.ts";
import type { BuildSystemPromptOptions } from "../../core/system-prompt.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import { forwardToolEvents } from "../../core/extensions/two-sided-forwarding.ts";
import type { LooplessToolHandlers } from "./loopless-tool-call.ts";

/** Where a two-sided extension runs whole: with the loop (fused, split-local; S29) or on the hand (hosted loop; S33). */
export type TwoSidedHome = "loop" | "hand";

/**
 * A loopless runtime's own extensions' `tool_call`/`tool_result` handlers, emitted as a session emits them. On a hand
 * (a call that carries its nested requests), a two-sided extension's handlers are forwarded to the loop that owns the
 * call instead of running here (S29). When the loop runs away from the user's machine (a hosted loop, S33/K5), the user's
 * machine is the extension's home: `twoSidedHome: "hand"` keeps its tool handlers here, and its loop hooks come here too
 * over the loop-hook link.
 */
export function extensionToolHandlers(
	runner: ExtensionRunner,
	twoSidedHome: TwoSidedHome = "loop",
): LooplessToolHandlers {
	const twoSided = twoSidedHome === "loop" ? runner.twoSidedExtensionPaths() : new Set<string>();
	const options = (nested: Parameters<typeof forwardToolEvents>[1] | undefined) =>
		nested === undefined || twoSided.size === 0 ? {} : { forward: forwardToolEvents(twoSided, nested) };
	return {
		beforeToolCall: ({ toolName, toolCallId, input, nested }) =>
			runner.hasHandlers("tool_call")
				? runner.emitToolCall({ type: "tool_call", toolName, toolCallId, input }, options(nested))
				: Promise.resolve(undefined),
		afterToolCall: ({ toolName, toolCallId, input, result, isError, nested }) =>
			runner.hasHandlers("tool_result")
				? runner.emitToolResult(
						{
							type: "tool_result",
							toolName,
							toolCallId,
							input,
							content: result.content,
							details: result.details,
							...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
							isError,
							usage: result.usage,
						},
						options(nested),
					)
				: Promise.resolve(undefined),
	};
}

/** The loop events a hand that is its extensions' home runs for a loop that runs elsewhere (S33, C8/K5). */
export type LooplessLoopHooks = (event: string, payload: JsonValue) => Promise<JsonValue>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The loop hooks of this runtime's own extensions, on the same runner (so the same extension instances) that runs its
 * tool calls: a two-sided extension keeps one state across its loop and tool hooks. Only a hand that is its extensions'
 * home (`twoSidedHome: "hand"`) runs them; any other hand refuses, because its extensions' loop hooks run where the loop
 * runs. The loop forwards the two events a session runs before a turn, in a session's order: `input` (the hooks
 * builtin's UserPromptSubmit runs there), whose result (`continue`, `handled`, or `transform` with the new text) the
 * loop returns from its own `input` handler, so its session acts on it as on a local one; then `before_agent_start`
 * with the prompt the session now has, whose combined result the loop returns from its `before_agent_start`. Each reply
 * also carries the messages its handlers sent (`sent`, which the loop sends with the same options) and their failures
 * (`errors`).
 */
export function extensionLoopHooks(
	runner: ExtensionRunner,
	twoSidedHome: TwoSidedHome,
	cwd: string,
	call: LoopHookCall,
): LooplessLoopHooks {
	return async (event, payload) => {
		if (twoSidedHome !== "hand") throw new Error("this hand is not the home of its extensions' loop hooks");
		if (!isRecord(payload) || typeof payload.sessionId !== "string" || typeof payload.idle !== "boolean")
			throw new Error(`malformed ${event} payload`);
		const { sessionId, idle } = payload;
		const images = imagesOf(payload.images);
		if (images === null) throw new Error(`malformed ${event} payload: images`);
		if (event === "input") {
			const { inputId, text, source, attribution, streamingBehavior } = payload;
			if (
				typeof inputId !== "string" ||
				typeof text !== "string" ||
				!isOneOf(source, INPUT_SOURCES) ||
				!isOneOf(attribution, INPUT_ATTRIBUTIONS) ||
				!(streamingBehavior === undefined || isOneOf(streamingBehavior, STREAMING_BEHAVIORS))
			)
				throw new Error("malformed input payload");
			return call.run(sessionId, cwd, idle, (effects) =>
				dispatchLoopHook(runner, call, effects, () =>
					runner.emitInput(text, images, source, streamingBehavior, inputId, attribution, isUserLoopHook),
				),
			);
		}
		if (event === "before_agent_start") {
			const { prompt, systemPrompt, trigger, preview, systemPromptOptions } = payload;
			if (
				typeof prompt !== "string" ||
				typeof systemPrompt !== "string" ||
				!isOneOf(trigger, TRIGGERS) ||
				!(preview === undefined || typeof preview === "boolean") ||
				!isRecord(systemPromptOptions)
			)
				throw new Error("malformed before_agent_start payload");
			// The loop's options as the loop built them: only `cwd` is this machine's (its workspace); the rest (context files,
			// skills, tools) describes the loop's machine. They are data for handlers to read; nothing here acts on them.
			const options = { ...(systemPromptOptions as Partial<BuildSystemPromptOptions>), cwd };
			return call.run(sessionId, cwd, idle, (effects) =>
				dispatchLoopHook(runner, call, effects, () =>
					runner.emitBeforeAgentStart(prompt, images, systemPrompt, options, {
						only: isUserLoopHook,
						trigger,
						...(preview === undefined ? {} : { preview }),
					}),
				),
			);
		}
		throw new Error(`no loop hooks run on a hand for ${event}`);
	};
}

/**
 * The user's loop hooks, which a hand runs for a hosted loop: its non-builtin extensions (C7(c), K5) and the hooks
 * builtin, which runs the user's shell hooks (C8). Every other builtin is the loop's own machinery (model, compaction,
 * todo, search): each side loads its own builtins, so those run where the loop runs, as S29 never forwards builtins.
 */
const isUserLoopHook = (extensionPath: string): boolean =>
	!extensionPath.startsWith("<builtin:") || extensionPath === "<builtin:hooks>";

const INPUT_SOURCES = ["interactive", "rpc", "extension"] as const satisfies readonly InputSource[];
const INPUT_ATTRIBUTIONS = ["user", "agent"] as const satisfies readonly InputAttribution[];
const STREAMING_BEHAVIORS = ["steer", "followUp"] as const;
const TRIGGERS = ["prompt", "delivery", "extension"] as const satisfies readonly BeforeAgentStartEvent["trigger"][];

const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
	typeof value === "string" && (allowed as readonly string[]).includes(value);

/** The images of a loop event, `undefined` when it has none, `null` when they are malformed. */
const imagesOf = (value: unknown): ImageContent[] | undefined | null =>
	value === undefined ? undefined : Array.isArray(value) && value.every(isImage) ? value : null;

const isImage = (value: unknown): value is ImageContent =>
	isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";

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

async function dispatchLoopHook(
	runner: ExtensionRunner,
	call: LoopHookCall,
	effects: LoopHookEffects,
	dispatch: () => Promise<object | undefined>,
): Promise<JsonValue> {
	// A handler's failure is reported, not thrown, as in a session; here it goes back to the loop host with the result.
	// The runner is shared with tool calls, so only failures inside this call's own async context are its own.
	const own = call.current();
	const errors: { extensionPath: string; event: string; error: string }[] = [];
	const stop = runner.onError(({ extensionPath, event, error }) => {
		if (own !== undefined && call.current() === own) errors.push({ extensionPath, event, error });
	});
	try {
		const result = await dispatch();
		const { sent, notices } = effects;
		return JSON.parse(
			JSON.stringify({
				...result,
				...(sent.length > 0 ? { sent } : {}),
				...(notices.length > 0 ? { notices } : {}),
				...(effects.dropped > 0 ? { droppedLate: effects.dropped } : {}),
				...(errors.length > 0 ? { errors } : {}),
			}),
		) as JsonValue;
	} finally {
		stop();
	}
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
