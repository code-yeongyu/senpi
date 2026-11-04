import { AsyncLocalStorage } from "node:async_hooks";
import type { JsonValue } from "@earendil-works/pi-ai";
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
 * runs. `before_agent_start` runs the `input` handlers first, as a session does before a turn (the hooks builtin's
 * UserPromptSubmit runs there), then `before_agent_start`; the combined result is returned as the session would apply it.
 */
export function extensionLoopHooks(
	runner: ExtensionRunner,
	twoSidedHome: TwoSidedHome,
	cwd: string,
	call: LoopHookCall,
): LooplessLoopHooks {
	return async (event, payload) => {
		if (twoSidedHome !== "hand") throw new Error("this hand is not the home of its extensions' loop hooks");
		if (event !== "before_agent_start") throw new Error(`no loop hooks run on a hand for ${event}`);
		if (
			!isRecord(payload) ||
			typeof payload.prompt !== "string" ||
			typeof payload.systemPrompt !== "string" ||
			typeof payload.sessionId !== "string"
		)
			throw new Error("malformed before_agent_start payload");
		const { prompt, systemPrompt, sessionId } = payload;
		return call.run(sessionId, cwd, () => dispatchBeforeAgentStart(runner, prompt, systemPrompt, cwd));
	};
}

/**
 * The user's loop hooks, which a hand runs for a hosted loop: its non-builtin extensions (C7(c), K5) and the hooks
 * builtin, which runs the user's shell hooks (C8). Every other builtin is the loop's own machinery (model, compaction,
 * todo, search): each side loads its own builtins, so those run where the loop runs, as S29 never forwards builtins.
 */
const isUserLoopHook = (extensionPath: string): boolean =>
	!extensionPath.startsWith("<builtin:") || extensionPath === "<builtin:hooks>";

async function dispatchBeforeAgentStart(
	runner: ExtensionRunner,
	prompt: string,
	systemPrompt: string,
	cwd: string,
): Promise<JsonValue> {
	// A handler's failure is reported, not thrown, as in a session; here it goes back to the loop host with the result.
	const errors: { extensionPath: string; event: string; error: string }[] = [];
	const stop = runner.onError(({ extensionPath, event, error }) => void errors.push({ extensionPath, event, error }));
	try {
		await runner.emitInput(prompt, undefined, "interactive", undefined, undefined, undefined, isUserLoopHook);
		const combined = await runner.emitBeforeAgentStart(
			prompt,
			undefined,
			systemPrompt,
			{ cwd },
			{ only: isUserLoopHook },
		);
		return JSON.parse(JSON.stringify({ ...combined, ...(errors.length > 0 ? { errors } : {}) })) as JsonValue;
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
	run<T>(sessionId: string, cwd: string, dispatch: () => Promise<T>): Promise<T>;
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
			const facts: LoopHookCallFacts = Object.freeze({
				sessionManager: readOnlySession(sessionId, cwd, () => live),
				signal: controller.signal,
				isIdle: () => true,
			});
			try {
				return await calls.run({ live: () => live, facts }, dispatch);
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
