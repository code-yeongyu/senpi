import { isAbsolute } from "node:path";
import type { AgentToolResult, ExecutionScope, HandScope, OpenHandScope } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { InlineExtension } from "../../core/extensions/types.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import { grantLooplessExecuteToRemoteExecutor } from "./loopless-execute-grant.ts";
import type { TwoSidedHome } from "./loopless-tool-handlers.ts";
import { createLooplessRuntimeFactory, type LooplessRuntime } from "./runtime-factory-loopless.ts";

function notFound(name: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: `Tool ${name} not found` }], details: {}, isError: true };
}

export interface LooplessHandOptions {
	extensionFactories?: InlineExtension[];
	startupSettingsManager?: SettingsManager;
	twoSidedHome?: TwoSidedHome;
}

/** A hand on loopless runtimes: its scopes for the remote executor, and its loop hooks for a loop that runs elsewhere. */
export interface LooplessHand {
	readonly openScope: OpenHandScope;
	/**
	 * Runs the loop hooks for `event` on the runtime of `scope`: the same runtime, and so the same extension instances,
	 * that its tool calls run on (S33, K5), opened here first when no call has opened it yet.
	 */
	runLoopHooks(scope: ExecutionScope, event: string, payload: JsonValue): Promise<JsonValue>;
	/** `runLoopHooks` for `serveLoopHooks`: the scope comes from the payload's `scope` (`{ id, root }`); refused without one. */
	readonly loopHooks: (event: string, payload: JsonValue) => Promise<JsonValue>;
	/** Disposes every runtime this hand opened, including one only loop hooks opened; every later call is refused. */
	close(): Promise<void>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function scopeOf(payload: JsonValue): ExecutionScope {
	const scope = isRecord(payload) ? payload.scope : undefined;
	if (!isRecord(scope) || typeof scope.id !== "string" || typeof scope.root !== "string")
		throw new Error("a loop-hook call names no scope");
	return { id: scope.id, root: scope.root };
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
	const factory = createLooplessRuntimeFactory(configuration, {
		...local,
		executeGrant: grantLooplessExecuteToRemoteExecutor(),
	});
	// One runtime per scope ID, bound to the root it was opened with. A scope's loop hooks need its extensions' state, so
	// a loop-hook call never reopens a scope that was disposed (only the remote executor reopens one, with openScope).
	const runtimes = new Map<string, { readonly root: string; readonly runtime: Promise<LooplessRuntime> }>();
	const disposed = new Set<string>();
	let closed = false;
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
		const opened = factory({ cwd: scope.root });
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
						? runtime.execute(call.name, call.toolCallId, call.arguments, call.signal, call.nested)
						: Promise.resolve(notFound(call.name)),
				isSequential: (name) => runtime.definitions.get(name)?.definition.executionMode === "sequential",
				dispose: () => {
					runtimes.delete(scope.id);
					disposed.add(scope.id);
					return runtime.dispose();
				},
			};
		},
		runLoopHooks: async (scope, event, payload) => (await runtimeOf(scope, false)).runLoopHooks(event, payload),
		loopHooks: async (event, payload) => (await runtimeOf(scopeOf(payload), false)).runLoopHooks(event, payload),
		async close() {
			closed = true;
			const open = [...runtimes.values()];
			runtimes.clear();
			await Promise.all(open.map(async ({ runtime }) => (await runtime).dispose()));
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
