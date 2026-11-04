import type { Transport, TransportFrame } from "../transport/transport.ts";
import type { AgentToolResult } from "../types.ts";
import {
	decodeRemoteMessage,
	encodeRemoteMessage,
	HAND_CONTROL_LANE,
	type RemoteHandMessage,
	type RemoteInvoke,
	toRemoteToolResult,
} from "./remote-protocol.ts";
import { authorize, type HandAuthority } from "./grant-verify.ts";
import { answerFloor, HAND_SELF_SENDER, type HandEpochFence } from "./remote-epoch.ts";
import type { HandLedger } from "./remote-hand-ledger.ts";
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
	/** Opens a scope lazily on its first call, bound to the scope's root (the canonical one a peer's grant check resolved). */
	readonly openScope: OpenHandScope;
	/**
	 * Whose calls this executor runs. A peer's call is checked against its grant before anything of it is recorded or
	 * opened, and a replaced grant snapshot re-checks every running call, aborting the ones it no longer allows (S27b).
	 */
	readonly authority: HandAuthority;
	/**
	 * The hand's durable record of its calls. With it, a call is recorded as dispatched before it runs, a restarted hand
	 * answers its interrupted calls `hand_restarted` without running them again, and a re-delivered invoke gets the
	 * recorded outcome. Without it, the hand remembers execution IDs only while it lives.
	 */
	readonly ledger?: HandLedger;
	/**
	 * The hand's epoch floors (S35), shared by every link's executor in this process. With it, a scope's owner raises the
	 * floor before it dispatches, and an invoke, abort or ack below the floor is refused or ignored. Without it, a floor
	 * is refused `epoch_unsupported`, so a session that moves never dispatches to this hand.
	 */
	readonly fence?: HandEpochFence;
	/** This hand process's identity in its `hello`; a fresh one per start by default. */
	readonly instance?: string;
	/**
	 * A call the hand could not record or answer (its durable record failed): the call gets no reply from this process,
	 * as from a hand that died, and a restarted hand answers it from the record. A failed restart recovery is reported
	 * here too, and this process then answers no frame. Reported here, never swallowed. The embedder owns the restart:
	 * close this executor and start a new one on the same store, or the call stays unanswered while this process lives.
	 */
	readonly onFault: (error: unknown) => void;
}

export interface RemoteExecutor {
	/** Execution IDs this hand has accepted, in arrival order (each runs at most once). */
	readonly accepted: () => readonly string[];
	/** Settles once a restarted hand has recovered its record and re-sent the outcomes the session has not acknowledged. */
	readonly ready: Promise<void>;
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
	const { transport, openScope, ledger, authority, fence } = options;
	const sender = authority.kind === "peer" ? authority.peer : HAND_SELF_SENDER;
	const admits = (lane: string, epoch: number | undefined): boolean =>
		fence === undefined || fence.admits(lane, epoch, sender);
	const scopes = new Map<string, ScopeState>();
	const accepted: string[] = [];
	const seen = new Set<string>();
	const running = new Map<string, { readonly controller: AbortController; readonly root: string }>();
	let closed = false;
	const stopWatching =
		authority.kind === "peer"
			? authority.verifier.onReplace(() => {
					for (const { controller, root } of running.values())
						if (!authority.verifier.verify(authority.peer, root).ok) controller.abort();
				})
			: () => {};

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
		const verdict = authorize(authority, call.scope.root);
		if (!verdict.ok) return refuse(lane, call.executionId, verdict.reason);
		if (!admits(lane, call.epoch)) return refuse(lane, call.executionId, "epoch_fenced");
		if (ledger === undefined && seen.has(call.executionId))
			return refuse(lane, call.executionId, "duplicate_execution");
		seen.add(call.executionId);
		const state = stateOf({ id: call.scope.id, root: verdict.root });
		if (typeof state === "string") return refuse(lane, call.executionId, state);
		let scope: HandScope;
		try {
			scope = await state.opened;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return refuse(lane, call.executionId, `scope_unavailable: ${reason}`);
		}
		if (ledger !== undefined) {
			const admission = await ledger.admit(call, () => admits(lane, call.epoch));
			if (admission.kind === "reply") return reply(lane, admission.message);
			if (admission.kind === "in_flight") return;
		}
		accepted.push(call.executionId);
		const controller = new AbortController();
		running.set(call.executionId, { controller, root: verdict.root });
		const sequential = scope.isSequential(call.name);
		const dependencies = sequential
			? [...(state.lastSequential ? [state.lastSequential] : []), ...state.wave]
			: state.lastSequential
				? [state.lastSequential]
				: [];
		const done = (async () => {
			await Promise.allSettled(dependencies);
			// Without a ledger this is the call's dispatch point: a floor raised while its scope opened or it waited on
			// earlier calls fences it here. With a ledger, the guarded `dispatch` step already decided it atomically.
			if (ledger === undefined && !admits(lane, call.epoch)) {
				running.delete(call.executionId);
				return refuse(lane, call.executionId, "epoch_fenced");
			}
			let result: AgentToolResult<unknown>;
			try {
				// The grant must still hold when the call starts: a snapshot installed while it waited (scope opening,
				// durable admission, earlier calls of its scope) may have revoked it, and then the tool never runs.
				if (controller.signal.aborted || !authorize(authority, call.scope.root).ok)
					throw new Error("The call's grant was revoked before it ran");
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
			const settled = toRemoteToolResult(result);
			reply(
				lane,
				ledger === undefined
					? { kind: "settled", executionId: call.executionId, result: settled }
					: await ledger.settle(call, settled),
			);
		})();
		done.catch((error: unknown) => options.onFault(error));
		if (sequential) {
			state.lastSequential = done;
			state.wave = [];
		} else state.wave.push(done);
	};

	const ready = (async () => {
		await fence?.ready;
		if (ledger === undefined) return;
		for (const { lane, message } of await ledger.recover()) reply(lane, message);
		reply(HAND_CONTROL_LANE, { kind: "hello", instance: options.instance ?? crypto.randomUUID() });
	})();
	ready.catch((error: unknown) => options.onFault(error));

	transport.onFrame(async (frame: TransportFrame) => {
		try {
			await ready;
		} catch {
			return;
		}
		let message: RemoteHandMessage;
		try {
			message = decodeRemoteMessage(frame.payload);
		} catch {
			return;
		}
		try {
			if (message.kind === "invoke") await invoke(frame.lane, message);
			else if (message.kind === "floor")
				reply(frame.lane, await answerFloor(fence, frame.lane, message.epoch, sender));
			else if ((message.kind === "abort" || message.kind === "ack") && !admits(frame.lane, message.epoch)) return;
			else if (message.kind === "abort") running.get(message.executionId)?.controller.abort();
			else if (message.kind === "ack") await ledger?.ack(message.executionId, () => admits(frame.lane, message.epoch));
		} catch (error) {
			options.onFault(error);
		}
	});

	return {
		accepted: () => [...accepted],
		ready,
		async close() {
			closed = true;
			stopWatching();
			for (const { controller } of running.values()) controller.abort();
			const opened = await Promise.allSettled([...scopes.values()].map((state) => state.opened));
			scopes.clear();
			await Promise.allSettled(
				opened.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value.dispose()] : [])),
			);
			transport.close();
		},
	};
}
