import { isAbsolute } from "node:path";
import {
	type AgentToolResult,
	DEFAULT_LOOP_HOOK_QUEUE_WAIT_MS,
	type ExecutionScope,
	type HandCall,
	type HandScope,
	type OpenHandScope,
} from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { HandWake } from "../../core/execution/hand-wake-route.ts";
import type { InlineExtension } from "../../core/extensions/types.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import { createHandFileOps } from "./hand-file-ops.ts";
import { loadFlock } from "./hand-flock-binding.ts";
import type { HandRunContext } from "./hand-run-allowlist.ts";
import { grantLooplessExecuteToRemoteExecutor } from "./loopless-execute-grant.ts";
import type { TwoSidedHome } from "./loopless-tool-handlers.ts";
import type { LooplessCallFacts } from "./loopless-brain-calls.ts";
import type { LooplessRuntime } from "./loopless-runtime.ts";
import { createLooplessRuntimeFactory } from "./runtime-factory-loopless.ts";

const handRun: { readonly context: HandRunContext; readonly flock: ReturnType<typeof loadFlock> } = {
	context: { uid: process.getuid?.() ?? -1, platform: process.platform, ownEnv: process.env },
	flock: loadFlock(),
};

/** What the issuing session sent with a call; an unknown surface is dropped, never read as another one. */
function callFacts(call: HandCall): LooplessCallFacts {
	const surface = call.promptSurface;
	return surface === "terminal" || surface === "app" || surface === "chat" ? { promptSurface: surface } : {};
}

function notFound(name: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: `Tool ${name} not found` }], details: {}, isError: true };
}

/**
 * A hand's durable wake outbox, per scope (brain/hand split H3): what a scope's work produces for the loop after the call
 * that started it ended. A scope's runtime is that scope's alone, so the scope that owns a late effect is the runtime it
 * came from.
 */
export interface HandWakes {
	offer(scope: string, wake: HandWake): void;
	/** The scope was disposed: its un-acked wakes are kept for the retention, then reported dropped to the loop. */
	closeScope(scope: string): void;
}

export interface LooplessHandOptions {
	extensionFactories?: InlineExtension[];
	startupSettingsManager?: SettingsManager;
	twoSidedHome?: TwoSidedHome;
	wakes?: HandWakes;
}

/** A hand on loopless runtimes: its scopes for the remote executor, and its loop hooks for a loop that runs elsewhere. */
export interface LooplessHand {
	readonly openScope: OpenHandScope;
	/**
	 * Runs the loop hooks for `event` on the runtime of `scope`: the same runtime, and so the same extension instances,
	 * that its tool calls run on (S33, K5), opened here first when no call has opened it yet.
	 */
	runLoopHooks(scope: ExecutionScope, event: string, payload: JsonValue): Promise<JsonValue>;
	/**
	 * `runLoopHooks` for `serveLoopHooks`: the scope comes from the payload's `scope` (`{ id, root }`); refused without one.
	 * `cancel` aborts when the loop host cancels the call.
	 */
	readonly loopHooks: (event: string, payload: JsonValue, cancel?: AbortSignal) => Promise<JsonValue>;
	/**
	 * The session a loop-hook call belongs to (its scope and loop session), for `serveLoopHooks`'s per-session order; none
	 * when the payload names neither, and such a call is refused when it runs.
	 */
	readonly loopHookSessionOf: (event: string, payload: JsonValue) => string | undefined;
	/** How long a call waits behind its session's previous call: this hand's event handler cap, or the shipped default. */
	readonly loopHookQueueWaitMs: number;
	/** Disposes every runtime this hand opened, including one only loop hooks opened; every later call is refused. */
	close(): Promise<void>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function scopeOf(payload: JsonValue): ExecutionScope {
	const scope = isRecord(payload) ? payload.scope : undefined;
	if (!isRecord(scope) || typeof scope.id !== "string" || typeof scope.root !== "string")
		throw new Error("a loop-hook call names no scope");
	// The scope is a part the loop-hook lane defines, so it is strict (loop-hook-envelope.ts).
	const unknownField = Object.keys(scope).find((key) => key !== "id" && key !== "root");
	if (unknownField !== undefined)
		throw new Error(`a loop-hook call's scope carries a field it does not name: ${unknownField}`);
	return { id: scope.id, root: scope.root };
}

function loopHookSessionOf(_event: string, payload: JsonValue): string | undefined {
	if (!isRecord(payload) || typeof payload.sessionId !== "string") return undefined;
	const { scope } = payload;
	if (!isRecord(scope) || typeof scope.id !== "string") return undefined;
	return JSON.stringify([scope.id, payload.sessionId]);
}

function loopHookQueueWaitOf(settings: SettingsManager): number {
	// A cap of 0 turns the handler cap off, never the queue wait. An invalid setting falls back to the default here as it
	// does for the runtime's handler budget, which reports it.
	try {
		return settings.getExtensionEventHandlerTimeoutMs() || DEFAULT_LOOP_HOOK_QUEUE_WAIT_MS;
	} catch (error) {
		if (error instanceof Error) return DEFAULT_LOOP_HOOK_QUEUE_WAIT_MS;
		throw error;
	}
}

/**
 * Opens a hand's execution scopes on loopless runtimes (brain/hand split, S27a): one runtime per scope, bound to the
 * scope's root as its cwd, built with the remote tool executor's grant so every call runs that runtime's extensions'
 * `tool_call`/`tool_result` handlers (permission checks among them) around the tool. Nothing about the session reaches
 * the runtime: the scope ID and root are all it is opened with. The loop hooks of a scope run on that scope's runtime.
 */
export function createLooplessHand(
	configuration: CliRuntimeConfiguration,
	local: LooplessHandOptions = {},
): LooplessHand {
	const startupSettingsManager =
		local.startupSettingsManager ?? SettingsManager.create(configuration.cwd, configuration.agentDir);
	const factory = createLooplessRuntimeFactory(configuration, {
		...local,
		startupSettingsManager,
		executeGrant: grantLooplessExecuteToRemoteExecutor(),
	});
	// One runtime per scope ID, bound to the root it was opened with. A scope's loop hooks need its extensions' state, so
	// a loop-hook call never reopens a scope that was disposed (only the remote executor reopens one, with openScope).
	const runtimes = new Map<string, { readonly root: string; readonly runtime: Promise<LooplessRuntime> }>();
	const disposed = new Set<string>();
	let closed = false;
	// A runtime is disposed once, whether its scope or close() gets there first.
	const disposals = new WeakMap<LooplessRuntime, Promise<void>>();
	const disposeOnce = (runtime: LooplessRuntime): Promise<void> => {
		const known = disposals.get(runtime);
		if (known !== undefined) return known;
		const disposing = runtime.dispose();
		disposals.set(runtime, disposing);
		return disposing;
	};
	const runtimeOf = (scope: ExecutionScope, reopen: boolean): Promise<LooplessRuntime> => {
		if (closed) return Promise.reject(new Error("this hand is closed"));
		if (!isAbsolute(scope.root))
			return Promise.reject(new Error(`scope root must be an absolute path: ${JSON.stringify(scope.root)}`));
		const known = runtimes.get(scope.id);
		if (known !== undefined)
			return known.root === scope.root
				? known.runtime
				: Promise.reject(
						new Error(`scope_binding_mismatch: scope ${JSON.stringify(scope.id)} is bound to another root`),
					);
		if (!reopen && disposed.has(scope.id))
			return Promise.reject(
				new Error(`scope ${JSON.stringify(scope.id)} was disposed; its extensions' loop-hook state is gone`),
			);
		disposed.delete(scope.id);
		const { wakes } = local;
		const opened = factory({
			cwd: scope.root,
			...(wakes === undefined ? {} : { wake: (wake: HandWake) => wakes.offer(scope.id, wake) }),
		});
		runtimes.set(scope.id, { root: scope.root, runtime: opened });
		opened.catch(() => runtimes.delete(scope.id));
		return opened;
	};
	return {
		async openScope(scope): Promise<HandScope> {
			const runtime = await runtimeOf(scope, true);
			return {
				run: (call) =>
					runtime.definitions.has(call.name)
						? runtime.execute(
								call.name,
								call.toolCallId,
								call.arguments,
								call.signal,
								call.nested,
								callFacts(call),
							)
						: Promise.resolve(notFound(call.name)),
				isSequential: (name) => runtime.definitions.get(name)?.definition.executionMode === "sequential",
				...(runtime.fileGuards === undefined
					? {}
					: { file: createHandFileOps(scope.root, runtime.fileGuards, handRun) }),
				dispose: () => {
					runtimes.delete(scope.id);
					disposed.add(scope.id);
					local.wakes?.closeScope(scope.id);
					return disposeOnce(runtime);
				},
			};
		},
		runLoopHooks: async (scope, event, payload) => (await runtimeOf(scope, false)).runLoopHooks(event, payload),
		loopHookSessionOf,
		loopHookQueueWaitMs: loopHookQueueWaitOf(startupSettingsManager),
		loopHooks: async (event, payload, cancel) =>
			(await runtimeOf(scopeOf(payload), false)).runLoopHooks(event, payload, cancel),
		async close() {
			closed = true;
			const open = [...runtimes.values()];
			runtimes.clear();
			// Every disposal runs to its end; a runtime that never opened has nothing to dispose.
			const settled = await Promise.allSettled(
				open.map(({ runtime }) =>
					runtime.then(
						(opened) => disposeOnce(opened),
						() => undefined,
					),
				),
			);
			const failures = settled.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, "disposing this hand's runtimes failed");
		},
	};
}

/** The scopes of {@link createLooplessHand}, for a hand that serves no loop hooks. */
export function createLooplessHandScopes(
	configuration: CliRuntimeConfiguration,
	local: LooplessHandOptions = {},
): OpenHandScope {
	return createLooplessHand(configuration, local).openScope;
}
