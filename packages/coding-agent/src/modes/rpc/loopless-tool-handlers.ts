import { AsyncLocalStorage } from "node:async_hooks";
import type { ImageContent, JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionRunner, LoopHookCallFacts } from "../../core/extensions/runner.ts";
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
		if (!isRecord(payload) || typeof payload.sessionId !== "string") throw new Error(`malformed ${event} payload`);
		const { sessionId } = payload;
		if (event === "input") {
			const { text, images } = payload;
			const imageList =
				images === undefined ? undefined : Array.isArray(images) && images.every(isImage) ? images : null;
			if (typeof text !== "string" || imageList === null) throw new Error("malformed input payload");
			return call.run(sessionId, cwd, (sent) =>
				dispatchLoopHook(runner, call, sent, () =>
					runner.emitInput(text, imageList, "interactive", undefined, undefined, undefined, isUserLoopHook),
				),
			);
		}
		if (event === "before_agent_start") {
			const { prompt, systemPrompt } = payload;
			if (typeof prompt !== "string" || typeof systemPrompt !== "string")
				throw new Error("malformed before_agent_start payload");
			return call.run(sessionId, cwd, (sent) =>
				dispatchLoopHook(runner, call, sent, () =>
					runner.emitBeforeAgentStart(prompt, undefined, systemPrompt, { cwd }, { only: isUserLoopHook }),
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

const isImage = (value: unknown): value is ImageContent =>
	isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";

/** A message a loop hook sent during its call, for the loop to send with the same options. */
export interface SentLoopMessage {
	readonly message: Parameters<LoopHookCallFacts["sendMessage"]>[0];
	readonly options?: Parameters<LoopHookCallFacts["sendMessage"]>[1];
}

async function dispatchLoopHook(
	runner: ExtensionRunner,
	call: LoopHookCall,
	sent: readonly SentLoopMessage[],
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
		return JSON.parse(
			JSON.stringify({
				...result,
				...(sent.length > 0 ? { sent } : {}),
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
	/** Runs `dispatch` as the call; `sent` collects what its handlers send through `pi.sendMessage`. */
	run<T>(sessionId: string, cwd: string, dispatch: (sent: readonly SentLoopMessage[]) => Promise<T>): Promise<T>;
}

export function createLoopHookCall(): LoopHookCall {
	const calls = new AsyncLocalStorage<{ readonly live: () => boolean; readonly facts: LoopHookCallFacts }>();
	return {
		current: () => {
			const call = calls.getStore();
			return call?.live() === true ? call.facts : undefined;
		},
		async run(sessionId, cwd, dispatch) {
			let live = true;
			const controller = new AbortController();
			const sent: SentLoopMessage[] = [];
			const facts: LoopHookCallFacts = Object.freeze({
				sessionManager: readOnlySession(sessionId, cwd, () => live),
				signal: controller.signal,
				isIdle: () => true,
				sendMessage: (message: SentLoopMessage["message"], options?: SentLoopMessage["options"]) => {
					if (!live) throw new Error("this loop-hook call has ended; it can no longer send messages");
					sent.push(options === undefined ? { message } : { message, options });
				},
			});
			try {
				return await calls.run({ live: () => live, facts }, () => dispatch(sent));
			} finally {
				live = false;
				controller.abort();
			}
		},
	};
}

function readOnlySession(sessionId: string, cwd: string, live: () => boolean): ReadonlySessionManager {
	const bound =
		<T>(read: () => T) =>
		(): T => {
			if (!live()) throw new Error("this loop-hook call has ended; its session identity is no longer bound");
			return read();
		};
	const unbound = (member: string) => (): never => {
		throw new Error(
			`sessionManager.${member} is loop-side: a loop-hook call on a hand carries only the session's id`,
		);
	};
	return Object.freeze({
		getSessionId: bound(() => sessionId),
		getSessionFile: bound((): string | undefined => undefined),
		getCwd: bound(() => cwd),
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
