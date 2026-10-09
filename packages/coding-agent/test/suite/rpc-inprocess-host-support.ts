import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../../src/core/agent-session-runtime.ts";
import { isSessionBusySnapshot } from "../../src/core/session-activity.ts";
import { holdSessionFile } from "../../src/core/session-holders.ts";
import { ProjectTrustStore } from "../../src/core/trust-manager.ts";
import type { SessionPathReservations } from "../../src/modes/rpc/host-reservations.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { type RpcSessionIdlePolicy, SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import { assistantMessage } from "./rpc-inprocess-host-metrics.ts";

/**
 * Holds every session's teardown where a real disposal spends its time (`waitForIdle`),
 * so a test can put a session INTO teardown and keep it there while it exercises
 * another command. Without it, the fake runtime disposes within one microtask and a
 * test about the teardown window would be a race the test usually wins.
 */
type WireRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };
type ListedRow = { sessionId: string; status: string; sessionPath?: string; attachments: number };

/** Fields these tests send on `open_session`. */
interface OpenFields {
	cwd?: string;
	sessionPath?: string;
	retain_on_disconnect?: boolean;
	kind?: "interactive" | "worker";
}

export interface TeardownGate {
	/** Every teardown from here on blocks until `release()`. */
	hold(): void;
	/** Lets the held teardowns finish. */
	release(): void;
}

/** One session's turn, driven by the test instead of by a model. */
export interface FakeTurn {
	/** The session reports a streaming, busy turn from here on. */
	start(): void;
	/** Settle the turn, persisting the assistant message a completed turn produces. */
	finish(): void;
	/** True once the host aborted this session's run (the close path does). */
	readonly aborted: boolean;
	/**
	 * A user bash starts; the returned promise settles when it ends. Like `AgentSession.executeBash`, the
	 * end records a `bashExecution` entry - `cancelled` when `abortBash()` ended it.
	 */
	startBash(): Promise<void>;
	/** Ends a running bash normally. */
	finishBash(): void;
	/** Delivery ids the admission ledger reports as held but not yet written. */
	readonly pendingDeliveries: string[];
}

/** What the rig's binding reports beyond command handling. */
export interface FakeBindingExtras {
	readonly pendingPrompts?: () => readonly Promise<unknown>[];
	readonly onRecord?: (record: WireRecord) => void;
}

/**
 * The in-process registry's runtime, faked at the seam the daemon path actually
 * uses: a REAL `SessionManager` (so the transcript on disk is the real one) with a
 * session whose turn the test starts and settles. `abort()` is honored - a turn
 * the host aborted persists nothing - so a test that expects a turn to outlive its
 * client's disconnect fails if the host tore the session down instead.
 */
function inProcessRuntimeFactory(): {
	createRuntime: CreateAgentSessionRuntimeFactory;
	turns: Map<string, FakeTurn>;
	teardown: TeardownGate;
} {
	const turns = new Map<string, FakeTurn>();
	let held: { promise: Promise<void>; resolve: () => void } | undefined;
	const teardown: TeardownGate = {
		hold: () => {
			let resolve!: () => void;
			const promise = new Promise<void>((settle) => {
				resolve = settle;
			});
			held = { promise, resolve };
		},
		release: () => {
			held?.resolve();
			held = undefined;
		},
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		new ProjectTrustStore(options.agentDir).set(options.cwd, true);
		const manager = options.sessionManager;
		const file = manager.getSessionFile();
		const hold =
			file === undefined
				? undefined
				: holdSessionFile(file, manager.getSessionId(), {
						cwd: options.cwd,
						expectExisting: false,
					});
		const state = { isStreaming: false, aborted: false };
		let bash: { end: (cancelled: boolean) => void } | undefined;
		const pendingDeliveries: string[] = [];
		const bashMessage = (cancelled: boolean) => ({
			role: "bashExecution" as const,
			command: "sleep",
			output: "",
			exitCode: cancelled ? undefined : 0,
			cancelled,
			truncated: false,
			timestamp: Date.now(),
		});
		turns.set(manager.getSessionFile() ?? manager.getSessionId(), {
			start: () => {
				state.isStreaming = true;
			},
			finish: () => {
				state.isStreaming = false;
				if (!state.aborted) manager.appendMessage(assistantMessage("turn result"));
			},
			get aborted() {
				return state.aborted;
			},
			startBash: () =>
				new Promise<void>((resolve) => {
					bash = {
						end: (cancelled) => {
							bash = undefined;
							manager.appendMessage(bashMessage(cancelled));
							resolve();
						},
					};
				}),
			finishBash: () => bash?.end(false),
			pendingDeliveries,
		});
		return {
			session: {
				sessionManager: manager,
				agentDir: options.agentDir,
				isFastModeActive: () => false,
				agent: { state: {} },
				getContextUsage: () => undefined,
				favoriteModels: [],
				scopedModels: [],
				get sessionFile() {
					return manager.getSessionFile();
				},
				get sessionId() {
					return manager.getSessionId();
				},
				get isStreaming() {
					return state.isStreaming;
				},
				get isBashRunning() {
					return bash !== undefined;
				},
				isCompacting: false,
				externalAdmission: {
					list: () => ({ pending: [...pendingDeliveries], emitted: [] }),
					close: () => {},
					reopen: () => {},
				},
				// Queued deliveries leave the ledger exactly as `AgentSession.clearQueue` drops them.
				clearQueue: () => {
					pendingDeliveries.splice(0);
					return Object.assign({ steering: [], followUp: [] }, { ordered: [] });
				},
				// Composed through the production predicate so this fake cannot drift
				// from the activity contract the sweep consults.
				get activitySnapshot() {
					return {
						isStreaming: state.isStreaming,
						isBashRunning: bash !== undefined,
						isCompacting: false,
						hasSessionWork: false,
						hasActiveWakeSource: false,
					};
				},
				get isSessionBusy() {
					return isSessionBusySnapshot(this.activitySnapshot);
				},
				extensionRunner: { hasHandlers: () => false, emit: async () => {} },
				subscribe: () => () => {},
				abort: async () => {
					state.aborted = true;
					state.isStreaming = false;
				},
				// The real abort only signals the child; the cancelled entry is written when it settles.
				abortBash: () => {
					const running = bash;
					if (running) queueMicrotask(() => running.end(true));
				},
				waitForIdle: async () => {
					await held?.promise;
				},
				dispose: () => hold?.release(),
				messages: [],
				pendingMessageCount: 0,
			},
			services: { cwd: options.cwd, agentDir: options.agentDir },
			diagnostics: [],
		} as unknown as CreateAgentSessionRuntimeResult;
	};
	return { createRuntime, turns, teardown };
}

/**
 * One in-process multi-session host: the real router, the real `RpcSessionRegistry`
 * and the real event writer with per-connection sinks, so every lifecycle decision
 * under test (attachment refcount, connection drop, idle sweep, empty-host exit)
 * runs its production code path on the runtime the daemon selects.
 */
export function createInProcessRig(
	dir: string,
	idle?: RpcSessionIdlePolicy,
	handle: (command: RpcCommand) => Promise<void> = async () => {},
	extras: FakeBindingExtras = {},
	pathReservations?: SessionPathReservations,
) {
	const { createRuntime, turns, teardown } = inProcessRuntimeFactory();
	// One clock for both halves of the idle contract: the registry stamps `lastCommandAt`
	// and the router's sweep compares against it.
	const registry = new RpcSessionRegistry({ agentDir: dir, createRuntime, now: idle?.now, pathReservations });
	const delivered: Array<{ connection?: string; record: WireRecord }> = [];
	const writer = new SessionEventWriter((line) => delivered.push({ record: JSON.parse(line) as WireRecord }));
	const registered = new Set<string>();
	const connect = (connection: string): string => {
		if (registered.has(connection)) return connection;
		writer.registerConnection(connection, {
			writeRaw: (line) => {
				const record = JSON.parse(line) as WireRecord;
				delivered.push({ connection, record });
				extras.onRecord?.(record);
			},
			waitForBackpressure: async () => {},
		});
		registered.add(connection);
		return connection;
	};
	const router = new SessionCommandRouter(
		registry,
		writer,
		{ cwd: dir },
		async () => ({
			handle,
			dispose: async () => {},
			cancelPendingExtensionUiRequests: () => {},
			...(extras.pendingPrompts ? { pendingPrompts: extras.pendingPrompts } : {}),
		}),
		{},
		idle,
	);
	let requests = 0;
	/** Drains the host's microtask-driven lifecycle chains, then its record queues. */
	const settle = async (): Promise<void> => {
		for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
		await writer.flush();
	};
	const send = async (connection: string, command: RpcCommand, id: string): Promise<WireRecord | undefined> => {
		const direct = await writer.withConnection(connect(connection), () => router.handle(command));
		await settle();
		return (direct as WireRecord | undefined) ?? delivered.findLast((entry) => entry.record.id === id)?.record;
	};
	return {
		registry,
		router,
		turns,
		teardown,
		settle,
		async open(connection: string, fields: OpenFields): Promise<WireRecord | undefined> {
			const id = `open-${++requests}`;
			return send(connection, { type: "open_session", id, ...fields }, id);
		},
		/** Any command, routed as `connection` sent it; resolves with its response once the host answered. */
		async send(connection: string, command: RpcCommand & { id: string }): Promise<WireRecord | undefined> {
			return send(connection, command, command.id);
		},
		async close(connection: string, sessionId: string): Promise<WireRecord | undefined> {
			const id = `close-${++requests}`;
			return send(connection, { type: "close_session", id, sessionId }, id);
		},
		/** The socket host's own drop order: unregister the transport, then release its sessions. */
		async drop(connection: string): Promise<void> {
			writer.unregisterConnection(connection);
			registered.delete(connection);
			await router.releaseConnection(connection);
			await settle();
		},
		async list(): Promise<ListedRow[]> {
			const response = await router.handle({ type: "list_sessions", id: `list-${++requests}` });
			return (response as { data?: { sessions?: ListedRow[] } } | undefined)?.data?.sessions ?? [];
		},
		/** Records this connection's socket received, in delivery order. */
		recordsFor(connection: string): WireRecord[] {
			return delivered.filter((entry) => entry.connection === connection).map((entry) => entry.record);
		},
		/** Every record the host wrote, on any destination. */
		records(): WireRecord[] {
			return delivered.map((entry) => entry.record);
		},
		async [Symbol.asyncDispose]() {
			await router.dispose();
		},
	};
}
