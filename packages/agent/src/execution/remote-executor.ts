import type { Transport, TransportFrame } from "../transport/transport.ts";
import type { AgentToolResult } from "../types.ts";
import {
	decodeRemoteMessage,
	encodeRemoteMessage,
	type RemoteHandMessage,
	type RemoteInvoke,
	toRemoteToolResult,
} from "./remote-protocol.ts";
import type { ExecutionScope } from "./tool-host.ts";

/** One call as a hand runs it: the raw name and arguments, never anything about the session that sent it. */
export interface HandCall {
	readonly toolCallId: string;
	readonly name: string;
	readonly arguments: unknown;
	readonly signal: AbortSignal;
}

/**
 * What a hand runs a scope's calls on. `run` owns the whole call: name resolution, argument preparation and
 * validation, the extensions' `tool_call`/`tool_result` handlers and the tool; it never rejects for a tool failure.
 */
export interface HandScope {
	run(call: HandCall): Promise<AgentToolResult<unknown>>;
	/** A tool that must not overlap other calls of its scope (`executionMode: "sequential"`). */
	isSequential(name: string): boolean;
	dispose(): Promise<void>;
}

export type OpenHandScope = (scope: ExecutionScope) => Promise<HandScope>;

export interface RemoteExecutorOptions {
	/** The hand's end of the link; lanes are execution scope IDs. */
	readonly transport: Transport;
	/** Opens a scope lazily on its first call, bound to the scope's root. */
	readonly openScope: OpenHandScope;
}

export interface RemoteExecutor {
	/** Execution IDs this hand has accepted, in arrival order (each runs at most once). */
	readonly accepted: () => readonly string[];
	close(): Promise<void>;
}

interface ScopeState {
	readonly root: string;
	readonly opened: Promise<HandScope>;
	lastSequential: Promise<unknown> | undefined;
	wave: Promise<unknown>[];
}

/**
 * The hand's side of remote tool execution (brain/hand split, S27a). Each scope keeps its own state, opened lazily and
 * bound to the root it was opened with: a later call naming the same scope with another root is refused, as is any
 * execution ID the hand has already accepted (dispatch at most once). The session reference a call carries is never
 * passed on: the hand keys on the scope and does not know the session (R16).
 */
export function createRemoteExecutor(options: RemoteExecutorOptions): RemoteExecutor {
	const { transport, openScope } = options;
	const scopes = new Map<string, ScopeState>();
	const accepted: string[] = [];
	const seen = new Set<string>();
	const running = new Map<string, AbortController>();
	let closed = false;

	const reply = (lane: string, message: RemoteHandMessage): void => {
		void transport.send(lane, encodeRemoteMessage(message)).catch(() => undefined);
	};
	const refuse = (lane: string, executionId: string, reason: string): void =>
		reply(lane, { kind: "refused", executionId, reason });

	const stateOf = (scope: ExecutionScope): ScopeState | string => {
		const known = scopes.get(scope.id);
		if (known !== undefined) return known.root === scope.root ? known : "scope_binding_mismatch";
		const opened = openScope(scope);
		opened.catch(() => undefined);
		const state: ScopeState = { root: scope.root, opened, lastSequential: undefined, wave: [] };
		scopes.set(scope.id, state);
		return state;
	};

	const invoke = async (lane: string, call: RemoteInvoke): Promise<void> => {
		if (closed) return refuse(lane, call.executionId, "hand_closed");
		if (lane !== call.scope.id) return refuse(lane, call.executionId, "scope_lane_mismatch");
		if (seen.has(call.executionId)) return refuse(lane, call.executionId, "duplicate_execution");
		seen.add(call.executionId);
		const state = stateOf(call.scope);
		if (typeof state === "string") return refuse(lane, call.executionId, state);
		let scope: HandScope;
		try {
			scope = await state.opened;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return refuse(lane, call.executionId, `scope_unavailable: ${reason}`);
		}
		accepted.push(call.executionId);
		const controller = new AbortController();
		running.set(call.executionId, controller);
		const sequential = scope.isSequential(call.name);
		const dependencies = sequential
			? [...(state.lastSequential ? [state.lastSequential] : []), ...state.wave]
			: state.lastSequential
				? [state.lastSequential]
				: [];
		const done = (async () => {
			await Promise.allSettled(dependencies);
			let result: AgentToolResult<unknown>;
			try {
				result = await scope.run({
					toolCallId: call.toolCallId,
					name: call.name,
					arguments: call.arguments,
					signal: controller.signal,
				});
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				result = { content: [{ type: "text", text }], details: {}, isError: true };
			} finally {
				running.delete(call.executionId);
			}
			reply(lane, { kind: "settled", executionId: call.executionId, result: toRemoteToolResult(result) });
		})();
		if (sequential) {
			state.lastSequential = done;
			state.wave = [];
		} else state.wave.push(done);
	};

	transport.onFrame(async (frame: TransportFrame) => {
		let message: RemoteHandMessage;
		try {
			message = decodeRemoteMessage(frame.payload);
		} catch {
			return;
		}
		if (message.kind === "invoke") await invoke(frame.lane, message);
		else if (message.kind === "abort") running.get(message.executionId)?.abort();
	});

	return {
		accepted: () => [...accepted],
		async close() {
			closed = true;
			for (const controller of running.values()) controller.abort();
			const opened = await Promise.allSettled([...scopes.values()].map((state) => state.opened));
			scopes.clear();
			await Promise.allSettled(
				opened.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value.dispose()] : [])),
			);
			transport.close();
		},
	};
}
