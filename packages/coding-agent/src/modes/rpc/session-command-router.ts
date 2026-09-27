import { VERSION } from "../../config.ts";
import { buildRpcSessionState } from "./connection-handler.ts";
import {
	AUTO_TITLE_PER_SESSION_CAPABILITY,
	AUTO_TITLE_SESSIONS_CAPABILITY,
	DURABLE_SESSION_ID_CAPABILITY,
	MEDIA_PLACEHOLDERS_CAPABILITY,
	RETAIN_ON_DISCONNECT_CAPABILITY,
	SESSION_CONTEXT_CAPABILITY,
	SESSION_KIND_CAPABILITY,
} from "./custom-capability.ts";
import { isHandoffBusy } from "./handoff-activity.ts";
import { HOST_MEMORY_SAMPLE_MS } from "./host-memory-sampler.ts";
import { protocolIdentity } from "./protocol-identity.ts";
import { sessionAutoTitleError, sessionContextError, sessionKindError } from "./rpc-input-validation.ts";
import type { RpcCommand, RpcResponse, RpcSessionClosedReason } from "./rpc-types.ts";
import {
	RPC_ERROR_INVALID_LAUNCH_PROFILE,
	RPC_ERROR_INVALID_SESSION_CONTEXT,
	RPC_ERROR_INVALID_SESSION_KIND,
	RPC_ERROR_MISSING_SESSION_ID,
	RPC_ERROR_OPEN_FAILED,
	RPC_ERROR_SESSION_CLOSING,
	RPC_ERROR_UNKNOWN_SESSION,
} from "./rpc-types.ts";
import { runWithSessionAttribution } from "./session-attribution.ts";
import { createRpcSessionBinding, type RpcSessionBinding } from "./session-binding.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import type { OpenRpcSession, RpcSessionLaunchProfile, RpcSessionRegistry } from "./session-registry.ts";
import { RpcSessionRegistryError } from "./session-registry.ts";

/** How often a draining host re-checks whether the work it is waiting for has settled. */
const DRAIN_SWEEP_MS = 50;

/** Binding factory seam, injectable so host wiring is testable without a full runtime stack. */
export type RpcBindingFactory = typeof createRpcSessionBinding;

/**
 * Occupancy policy for the shared multi-session host. All fields are opt-in:
 * a router constructed without a policy keeps today's behavior (sessions live
 * until close_session; the host never self-exits).
 */
export interface RpcSessionIdlePolicy {
	/** Injectable clock (defaults to Date.now) for deterministic tests. */
	now?: () => number;
	/** Evict open sessions whose last routed command or session-owned work settled longer ago than this. */
	idleEvictionMs?: number;
	/** Invoke onEmptyExit once the registry has stayed empty for this long. */
	emptyExitMs?: number;
	/** Host shutdown hook fired by the empty-exit window; called at most once. */
	onEmptyExit?: () => void;
	/** Close connections whose last attached session has finished handoff parking. */
	onHandoffParked?: (connections: readonly string[]) => Promise<void>;
	/**
	 * Consulted every tick before the empty-exit window advances. Returning false
	 * both blocks the exit and resets the window, so a host with a connected but
	 * sessionless client stays up instead of exiting under its supervisor.
	 */
	canExitWhenEmpty?: () => boolean;
}

/**
 * How one caller claims a close. `detach` (a client going away) is the only mode a
 * retained session may answer by staying open, so it is unrepresentable together
 * with `drainAttachments` - draining ENDS the session and must always reach zero.
 */
type CloseClaimOptions = { drainAttachments: true; detach?: never } | { drainAttachments: false; detach?: boolean };

function error(
	id: string | undefined,
	command: string,
	code: string,
	data?: Readonly<Record<string, unknown>>,
): RpcResponse {
	// `errorData` carries what a client has to ACT on (who holds a path, when to retry); the
	// stable code stays the string every existing client already switches on.
	return {
		id,
		type: "response",
		command,
		success: false,
		error: code,
		...(data && { errorCode: code, errorData: data }),
	};
}

/** Routes control messages and enforces a routing handle for every session command. */
export class SessionCommandRouter {
	private readonly bindings = new Map<string, RpcSessionBinding>();
	/** Session handles opened by each connection, with one count per attachment. */
	private readonly sessionsByConnection = new Map<string, Map<string, number>>();
	/** Opens currently awaiting runtime/binding setup, keyed by connection. */
	private readonly opensByConnection = new Map<string, Set<Promise<void>>>();
	/** Connections whose socket has already been detached. */
	private readonly releasedConnections = new Set<string>();
	private readonly registry: Pick<
		RpcSessionRegistry,
		| "openSession"
		| "peek"
		| "getForCommand"
		| "beginClose"
		| "close"
		| "closeMarked"
		| "list"
		| "size"
		| "setWorkerAdmission"
	>;
	private readonly writer: SessionEventWriter;
	private readonly defaults: Pick<
		RpcSessionLaunchProfile,
		"cwd" | "permissionPreset" | "creationModel" | "initialThinkingLevel"
	>;
	private readonly createBinding: typeof createRpcSessionBinding;
	private readonly connectionOptions: Parameters<typeof createRpcSessionBinding>[4];
	private readonly widths = new Map<string, Map<string, number>>();
	private readonly pendingCapabilities = new Map<string, string[]>();
	private readonly finalizations = new Map<string, { promise: Promise<void>; resolve: () => void }>();
	private readonly idleNow: () => number;
	private readonly idleEvictionMs: number;
	private readonly emptyExitMs: number;
	private readonly onEmptyExit?: () => void;
	private readonly canExitWhenEmpty?: () => boolean;
	private sweepTimer: ReturnType<typeof setInterval> | undefined;
	private drainTimer: ReturnType<typeof setInterval> | undefined;
	private draining = false;
	private handoffParks = 0;
	private drainExitRequested = false;
	private readonly handoffClosed = new Set<string>();
	private readonly activeRequests = new Map<string | undefined, number>();
	private readonly onHandoffParked?: RpcSessionIdlePolicy["onHandoffParked"];
	private emptySince: number | undefined;
	/** Halves the idle window while the host reports memory pressure; never refuses work. */
	private memoryPressure = false;

	constructor(
		registry: Pick<
			RpcSessionRegistry,
			| "openSession"
			| "peek"
			| "getForCommand"
			| "beginClose"
			| "close"
			| "closeMarked"
			| "list"
			| "size"
			| "setWorkerAdmission"
		>,
		writer: SessionEventWriter,
		defaults: Pick<RpcSessionLaunchProfile, "cwd" | "permissionPreset" | "creationModel" | "initialThinkingLevel">,
		createBinding: typeof createRpcSessionBinding = createRpcSessionBinding,
		connectionOptions: Parameters<typeof createRpcSessionBinding>[4] = {},
		idle?: RpcSessionIdlePolicy,
	) {
		this.registry = registry;
		this.writer = writer;
		this.defaults = defaults;
		this.createBinding = createBinding;
		this.connectionOptions = connectionOptions;
		this.idleNow = idle?.now ?? Date.now;
		this.idleEvictionMs = idle?.idleEvictionMs ?? Number.POSITIVE_INFINITY;
		this.emptyExitMs = idle?.emptyExitMs ?? Number.POSITIVE_INFINITY;
		this.onEmptyExit = idle?.onEmptyExit;
		this.onHandoffParked = idle?.onHandoffParked;
		this.canExitWhenEmpty = idle?.canExitWhenEmpty;
		if (Number.isFinite(this.idleEvictionMs) || Number.isFinite(this.emptyExitMs)) {
			// Unref'd: occupancy hygiene must never be the reason the event loop stays open.
			const tickMs = Math.max(20, Math.min(5_000, Math.min(this.idleEvictionMs, this.emptyExitMs) / 4));
			this.sweepTimer = setInterval(() => this.sweepIdleSessions(), tickMs);
			this.sweepTimer.unref?.();
		}
	}

	/** Live sessions the host holds, including ones opening or closing. */
	get sessionCount(): number {
		return this.registry.size;
	}

	/**
	 * Park attached and detached sessions once turns and requests settle. Durable wake sources
	 * resume on reopen, unlike active work. Repeated requests (including grace expiry) rescan
	 * without announcing again or aborting a turn.
	 */
	beginDrain(): void {
		this.draining = true;
		this.stopSweep();
		this.sweepDrain();
		if (this.drainTimer !== undefined || this.drainExitRequested) return;
		// Unref'd: a draining host must never be the reason the event loop stays open.
		this.drainTimer = setInterval(() => this.sweepDrain(), DRAIN_SWEEP_MS);
		this.drainTimer.unref?.();
	}

	/** One drain pass: park what has settled, and exit once the host holds nothing. */
	private sweepDrain(): void {
		// An accepted open can still be constructing a runtime or binding.
		if (this.activeRequests.has(undefined)) return;
		for (const { sessionId, status } of this.registry.list()) {
			if (status !== "open") continue;
			const entry = this.registry.peek(sessionId);
			if (!entry || this.activeRequests.has(sessionId)) continue;
			// Both signals are optional: a runtime that does not publish an activity
			// snapshot cannot be proven busy, and a park that waits for a signal the
			// runtime never emits would strand the session on the old generation.
			const snapshot = entry.runtime?.session.activitySnapshot;
			if (entry.worker?.handoffBusy === true || (snapshot !== undefined && isHandoffBusy(snapshot))) continue;
			this.handoffClosed.add(sessionId);
			this.handoffParks++;
			void this.evictIdleSession(sessionId, "handoff_parked")
				.catch((cause: unknown) => {
					process.stderr.write(`senpi rpc handoff park ${sessionId} failed: ${String(cause)}\n`);
				})
				.finally(() => {
					this.handoffParks--;
					this.sweepDrain();
				});
		}
		if (this.registry.size > 0 || this.handoffParks > 0 || this.finalizations.size > 0) return;
		if (this.drainTimer !== undefined) {
			clearInterval(this.drainTimer);
			this.drainTimer = undefined;
		}
		this.stopSweep();
		if (this.drainExitRequested) return;
		this.drainExitRequested = true;
		this.onEmptyExit?.();
	}

	/**
	 * Raised by the host's memory sampler. Under pressure idle sessions are parked at
	 * HALF the configured window, which returns their memory to the process sooner.
	 * Deliberately the only lever: the host never refuses or kills a session for memory.
	 */
	/**
	 * Above the refuse watermark the host declines to CREATE worker sessions until the next
	 * sample can clear it; everything it already holds keeps being served (#1905).
	 */
	setMemoryCritical(critical: boolean, rssMb: number): void {
		this.registry.setWorkerAdmission(critical ? { rssMb, retry_after_ms: HOST_MEMORY_SAMPLE_MS } : undefined);
	}

	setMemoryPressure(pressure: boolean): void {
		this.memoryPressure = pressure;
	}

	/**
	 * Every routed command runs inside its session's attribution scope, so a stall the
	 * loop-lag watchdog observes right after this dispatch can name the session that
	 * caused it - and anything the command starts inherits the attribution.
	 */
	handle(command: RpcCommand): Promise<RpcResponse | undefined> {
		const sessionId = "sessionId" in command ? command.sessionId : undefined;
		// A parked handle is answered by its terminal record and connection close, never unknown_session.
		if (this.draining && sessionId !== undefined && this.handoffClosed.has(sessionId))
			return Promise.resolve(undefined);
		if (this.draining && command.type === "open_session")
			return Promise.resolve(error(command.id, command.type, "host_draining"));
		this.activeRequests.set(sessionId, (this.activeRequests.get(sessionId) ?? 0) + 1);
		return runWithSessionAttribution({ sessionId }, () => this.dispatch(command)).finally(() => {
			const remaining = (this.activeRequests.get(sessionId) ?? 1) - 1;
			if (remaining > 0) this.activeRequests.set(sessionId, remaining);
			else this.activeRequests.delete(sessionId);
			if (this.draining) this.sweepDrain();
		});
	}

	private async dispatch(command: RpcCommand): Promise<RpcResponse | undefined> {
		if (command.type === "get_protocol_info") {
			const capabilities = new Set([
				"multi_session",
				AUTO_TITLE_SESSIONS_CAPABILITY,
				MEDIA_PLACEHOLDERS_CAPABILITY,
				// Host capabilities, not client opt-ins: only a multi-session host owns the
				// attachment refcount `open_session.retain_on_disconnect` detaches from, the
				// per-session launch profile `context`/`auto_title` travel on, and the session
				// listing `kind` filters.
				RETAIN_ON_DISCONNECT_CAPABILITY,
				SESSION_CONTEXT_CAPABILITY,
				SESSION_KIND_CAPABILITY,
				AUTO_TITLE_PER_SESSION_CAPABILITY,
				// Only a multi-session host can refuse a duplicate durable id, because only it
				// sees every live session's identity.
				DURABLE_SESSION_ID_CAPABILITY,
				...(this.connectionOptions?.capabilities ?? []),
			]);
			return {
				id: command.id,
				type: "response",
				command: "get_protocol_info",
				success: true,
				data: {
					protocolVersion: 1,
					serverVersion: VERSION,
					capabilities: [...capabilities],
					mode: "multi",
					...protocolIdentity(),
				},
			};
		}
		if (command.type === "list_sessions") {
			// Worker sessions are machine-driven work: a client sees them only by asking, and
			// the opaque context blob travels only on that listing, never to every connection.
			const rows = this.registry.list();
			const sessions =
				command.include_workers === true
					? rows
					: rows.filter((row) => row.kind !== "worker").map(({ context: _context, ...row }) => row);
			return {
				id: command.id,
				type: "response",
				command: "list_sessions",
				success: true,
				data: { sessions },
			};
		}
		if (command.type === "open_session") return this.openWithBarrier(command);
		if (command.type === "close_session") return this.close(command);
		if (command.type === "set_client_info" && !command.sessionId) {
			const connection = this.writer.currentConnection();
			if (connection !== undefined) {
				this.pendingCapabilities.set(connection, command.capabilities ?? []);
				this.writer.setConnectionCapabilities(connection, command.capabilities ?? []);
			}
			return { id: command.id, type: "response", command: "set_client_info", success: true } as RpcResponse;
		}
		if (!command.sessionId) return error(command.id, command.type, RPC_ERROR_MISSING_SESSION_ID);
		try {
			this.registry.getForCommand(command.sessionId, command.type);
			const binding = this.bindings.get(command.sessionId);
			if (!binding) return error(command.id, command.type, RPC_ERROR_UNKNOWN_SESSION);
			await binding.handle(command);
			return undefined;
		} catch (cause) {
			return error(command.id, command.type, this.code(cause));
		}
	}

	async dispose(): Promise<void> {
		this.drainExitRequested = true;
		this.stopSweep();
		if (this.drainTimer !== undefined) clearInterval(this.drainTimer);
		await Promise.all(
			[...this.bindings.entries()].map(async ([sessionId, binding]) => {
				const claim = this.tryClaimClose(sessionId, { drainAttachments: true });
				if (!claim) return;
				if (claim.finalizer) {
					await this.finalizeClose(sessionId, binding, () =>
						this.writer.closeSession(
							sessionId,
							{ type: "response", command: "close_session", success: true, data: {} },
							"host_shutdown",
						),
					);
				} else await this.finalizations.get(sessionId)?.promise;
				this.writer.forgetSession(sessionId);
			}),
		);
		this.bindings.clear();
	}

	/**
	 * One occupancy sweep. Evicts open sessions idle longer than idleEvictionMs,
	 * where "idle" is the COMPLETE session-owned activity contract
	 * (`AgentSession.isSessionBusy`: agent run, bash, background terminal jobs and
	 * other published wake sources, compaction, barrier-held session work) - busy
	 * sessions restart their idle clock instead, so work that outlives a turn is
	 * never killed. While the host reports memory pressure the window is HALVED, so an
	 * idle session's memory returns to the process sooner. Fires onEmptyExit once the
	 * registry has STAYED empty for emptyExitMs with the exit permitted; any live session
	 * or connected client resets that window. Runs on an unref'd interval and is safe to
	 * call directly.
	 */
	sweepIdleSessions(): void {
		const now = this.idleNow();
		const idleEvictionMs = this.memoryPressure ? this.idleEvictionMs / 2 : this.idleEvictionMs;
		if (Number.isFinite(idleEvictionMs)) {
			for (const { sessionId, status } of this.registry.list()) {
				if (status !== "open") continue;
				const entry = this.registry.peek(sessionId);
				if (!entry) continue;
				if (entry.worker?.busy || entry.runtime?.session.isSessionBusy) {
					// Session-owned work defers eviction; the window restarts when it settles.
					entry.lastCommandAt = now;
					continue;
				}
				if (now - entry.lastCommandAt >= idleEvictionMs) void this.evictIdleSession(sessionId);
			}
		}
		if (Number.isFinite(this.emptyExitMs)) {
			if (this.registry.size === 0 && (this.canExitWhenEmpty?.() ?? true)) {
				if (this.emptySince === undefined) this.emptySince = now;
				else if (now - this.emptySince >= this.emptyExitMs) {
					this.stopSweep();
					this.onEmptyExit?.();
				}
			} else {
				this.emptySince = undefined;
			}
		}
	}

	/**
	 * Idle-session eviction: the same refcounted close sequence as an explicit
	 * close_session, draining every attachment because eviction ends the shared
	 * session, not one client's claim. Races with concurrent lifecycle paths are
	 * tolerated the same way releaseOwnedSession tolerates them.
	 *
	 * Evicting a RETAINED session is a PARK, not a close: that session was opened to
	 * outlive its clients, so the terminal record names the file it reopens by
	 * (`session_parked`) instead of reporting a close nobody requested. The teardown
	 * itself is identical - retention never outlives the idle window.
	 */
	private async evictIdleSession(sessionId: string, reason?: RpcSessionClosedReason): Promise<void> {
		// Read before the claim: the entry is gone once the teardown completes, and a park
		// record without the session's path would not be actionable (so a retained session
		// with no file to reopen by ends as an ordinary close).
		const retained = this.registry.peek(sessionId);
		const parkedPath =
			retained?.retainOnDisconnect === true || reason === "handoff_parked" ? retained?.sessionPath : undefined;
		const owners =
			reason === "handoff_parked"
				? [...this.sessionsByConnection]
						.filter(([, owned]) => owned.has(sessionId))
						.map(([connection]) => connection)
				: [];
		// A failed claim means an explicit close raced us and owns the entry now.
		const claim = this.tryClaimClose(sessionId, { drainAttachments: true });
		if (!claim) return;
		const binding = this.bindings.get(sessionId);
		binding?.cancelPendingExtensionUiRequests?.();
		if (reason !== "handoff_parked") this.forgetSessionOwnership(sessionId);
		if (claim.finalizer) {
			await this.finalizeClose(sessionId, binding, () =>
				// A drain names ITS reason on the close record. An idle sweep of a RETAINED
				// session parks instead: the file reopens by path. Anything else is a close.
				parkedPath !== undefined && reason === undefined
					? this.writer.parkSession(sessionId, parkedPath)
					: this.writer.closeSession(
							sessionId,
							{ type: "response", command: "close_session", success: true, data: {} },
							reason ?? "idle_evicted",
							reason === "handoff_parked" ? parkedPath : undefined,
						),
			);
		} else {
			await this.finalizations.get(sessionId)?.promise;
		}
		if (reason === "handoff_parked") {
			this.forgetSessionOwnership(sessionId);
			await this.onHandoffParked?.(owners.filter((connection) => !this.sessionsByConnection.has(connection)));
		}
		// The runtime is disposed and routing handles are unique per process
		// epoch, so nothing can emit under this id again: drop the writer's
		// per-session bookkeeping instead of retaining it for the host's life.
		this.writer.forgetSession(sessionId);
	}

	/** Drops per-connection records for a handle the host closed on its own. */
	private forgetSessionOwnership(sessionId: string): void {
		for (const [connection, owned] of this.sessionsByConnection) {
			owned.delete(sessionId);
			if (owned.size === 0) this.sessionsByConnection.delete(connection);
		}
		this.widths.delete(sessionId);
	}

	private stopSweep(): void {
		if (this.sweepTimer === undefined) return;
		clearInterval(this.sweepTimer);
		this.sweepTimer = undefined;
	}

	private openWithBarrier(command: Extract<RpcCommand, { type: "open_session" }>): Promise<RpcResponse | undefined> {
		const owner = this.writer.currentConnection();
		if (owner === undefined) return this.open(command);
		let resolveBarrier!: () => void;
		const barrier = new Promise<void>((resolve) => {
			resolveBarrier = resolve;
		});
		const opens = this.opensByConnection.get(owner) ?? new Set<Promise<void>>();
		// Every open already accepted anywhere on this host, not just on this connection: the
		// in-process runtime serves them on ONE loop, so the wait this caller faces is the total.
		let inFlight = 0;
		for (const pending of this.opensByConnection.values()) inFlight += pending.size;
		opens.add(barrier);
		this.opensByConnection.set(owner, opens);
		// Before the open reaches the loop: a client that later hits its deadline can then say
		// where it was queued instead of reporting a bare timeout (senpi#1844).
		if (command.id !== undefined)
			this.writer.sendOpenQueued(owner, {
				type: "queued",
				for_request: command.id,
				position: inFlight + 1,
				in_flight: inFlight,
			});
		return this.open(command, owner).finally(() => {
			resolveBarrier();
			opens.delete(barrier);
			if (opens.size === 0) this.opensByConnection.delete(owner);
		});
	}

	private async open(
		command: Extract<RpcCommand, { type: "open_session" }>,
		owner?: string,
	): Promise<RpcResponse | undefined> {
		// The opaque per-session inputs are parsed HERE, at the wire boundary, so the
		// registry, the runtime and the extensions downstream receive values already
		// proven to satisfy every documented cap.
		const kindError = sessionKindError(command.kind);
		if (kindError) return error(command.id, "open_session", `${RPC_ERROR_INVALID_SESSION_KIND}: ${kindError}`);
		const contextError = sessionContextError(command.context);
		if (contextError)
			return error(command.id, "open_session", `${RPC_ERROR_INVALID_SESSION_CONTEXT}: ${contextError}`);
		const autoTitleError = sessionAutoTitleError(command.auto_title);
		if (autoTitleError)
			return error(command.id, "open_session", `${RPC_ERROR_INVALID_LAUNCH_PROFILE}: ${autoTitleError}`);
		let opened: OpenRpcSession | undefined;
		try {
			opened = await this.registry.openSession(
				{
					cwd: command.cwd ?? this.defaults.cwd,
					sessionPath: command.sessionPath,
					permissionPreset: command.permissionPreset ?? this.defaults.permissionPreset,
					creationModel:
						command.provider && command.modelId
							? { provider: command.provider, modelId: command.modelId }
							: this.defaults.creationModel,
					initialThinkingLevel: command.thinkingLevel ?? this.defaults.initialThinkingLevel,
					sessionKind: command.kind,
					sessionContext: command.context,
					...(command.durableSessionId !== undefined ? { durableSessionId: command.durableSessionId } : {}),
					...(typeof command.auto_title === "boolean" ? { autoTitle: command.auto_title } : {}),
				},
				// Host lifecycle policy, deliberately outside the immutable launch profile.
				{ retainOnDisconnect: command.retain_on_disconnect === true },
			);
			const openedSession = opened;
			const entry = this.registry.getForCommand(openedSession.sessionId, "open_session");
			this.writer.setSessionKind(openedSession.sessionId, entry.kind);
			if (owner !== undefined) {
				if (!this.writer.hasRegisteredConnectionCapabilities(owner))
					this.writer.setConnectionCapabilities(
						owner,
						this.pendingCapabilities.get(owner) ?? this.connectionOptions?.capabilities ?? [],
					);
				this.writer.attachConnectionToSession(owner, openedSession.sessionId);
			}
			// A client that dies without close_session (terminal closed, SIGKILL, dropped
			// SSH) still holds this handle's attachment and its path reservation. Remember
			// which connection owns it so releaseConnection() can close exactly that.
			if (owner !== undefined) {
				const owned = this.sessionsByConnection.get(owner) ?? new Map<string, number>();
				owned.set(openedSession.sessionId, (owned.get(openedSession.sessionId) ?? 0) + 1);
				this.sessionsByConnection.set(owner, owned);
			}
			if (!this.bindings.has(openedSession.sessionId)) {
				this.bindings.set(
					openedSession.sessionId,
					await this.createBinding(
						openedSession.sessionId,
						entry,
						this.writer,
						() => void this.close({ type: "close_session", sessionId: openedSession.sessionId }),
						{
							...this.connectionOptions,
							capabilities:
								owner !== undefined
									? (this.pendingCapabilities.get(owner) ?? this.connectionOptions?.capabilities ?? [])
									: this.connectionOptions?.capabilities,
							sharedWidth: {
								getWidth: () => {
									const widths = this.widths.get(openedSession.sessionId);
									return widths?.size ? Math.min(...widths.values()) : 80;
								},
								setWidth: (connectionId, width) => {
									if (connectionId !== undefined) {
										const widths = this.widths.get(openedSession.sessionId) ?? new Map<string, number>();
										widths.set(connectionId, width);
										this.widths.set(openedSession.sessionId, widths);
									}
								},
								clearWidth: (connectionId) => {
									const widths = this.widths.get(openedSession.sessionId);
									if (connectionId !== undefined) widths?.delete(connectionId);
									if (widths?.size === 0) this.widths.delete(openedSession.sessionId);
								},
								setCapabilities: (connectionId, capabilities) => {
									if (connectionId !== undefined) {
										this.writer.setConnectionCapabilities(connectionId, capabilities);
										this.pendingCapabilities.set(connectionId, [...capabilities]);
										for (const binding of this.bindings.values()) binding.rerenderComponents?.();
									}
								},
								hasRenderedComponents: (sessionId) => this.writer.hasCapableConnection(sessionId),

								connectionId: () => this.writer.currentConnection(),
								onChange: () => {
									for (const binding of this.bindings.values()) binding.rerenderComponents?.();
								},
							},
						},
					),
				);
				if (entry.worker) entry.worker.bindingReady = true;
				// Wake the drain sweep the moment a session settles, so a handoff parks it
				// without waiting for the next timer tick. Both hooks are OPTIONAL: an
				// embedder's runtime and the suite's fakes implement the session surface
				// they need and nothing more, and an open must never fail because a
				// settle notification is unavailable - the periodic sweep still parks it.
				const settled = () => {
					if (this.draining) queueMicrotask(() => this.sweepDrain());
				};
				if (typeof entry.worker?.subscribeSettled === "function") entry.worker.subscribeSettled(settled);
				else if (typeof entry.runtime?.session.subscribe === "function")
					entry.runtime.session.subscribe((event) => {
						if (event.type === "agent_settled" || event.type === "agent_idle") settled();
					});
				if (entry.worker)
					void entry.worker.exited.then(async () => {
						await this.finalizations.get(openedSession.sessionId)?.promise;
						this.bindings.delete(openedSession.sessionId);
						this.forgetSessionOwnership(openedSession.sessionId);
						this.writer.forgetSession(openedSession.sessionId);
					});
			}
			if (!this.draining && owner !== undefined && this.releasedConnections.has(owner)) {
				this.releaseOwnerAttachment(owner, openedSession.sessionId);
				await this.releaseOwnedSession(openedSession.sessionId);
				return undefined;
			}
			const state =
				entry.worker?.snapshot?.state ?? (entry.runtime ? buildRpcSessionState(entry.runtime.session) : undefined);
			if (!state) throw new Error("Session state was not created");
			this.writer.enqueue(opened.sessionId, {
				id: command.id,
				type: "response",
				command: "open_session",
				success: true,
				data: {
					sessionId: opened.sessionId,
					state,
					...(opened.attached ? { attached: true } : {}),
				},
			});
			return undefined;
		} catch (cause) {
			if (opened) {
				try {
					await this.registry.close(opened.sessionId);
				} catch {
					/* The open rollback has already removed the entry. */
				}
			}
			return error(command.id, "open_session", this.code(cause), this.detail(cause));
		}
	}

	/**
	 * Releases every session a dropped connection still owned. Each handle goes through
	 * the same refcounted close as an explicit close_session, so a session another
	 * connection is still attached to keeps running and only the last owner tears it down.
	 */
	async releaseConnection(connectionId: string): Promise<void> {
		this.releasedConnections.add(connectionId);
		this.writer.clearConnectionCapabilities(connectionId);
		for (const sessionId of this.sessionsByConnection.get(connectionId)?.keys() ?? [])
			this.writer.detachConnectionFromSession(connectionId, sessionId);
		for (const [sessionId, widths] of this.widths) {
			widths.delete(connectionId);
			if (widths.size === 0) this.widths.delete(sessionId);
		}
		for (const binding of this.bindings.values()) binding.rerenderComponents?.();
		const opens = this.opensByConnection.get(connectionId);
		const owned = this.sessionsByConnection.get(connectionId);
		this.sessionsByConnection.delete(connectionId);
		if (this.draining) {
			// Drain owns teardown now, even when a client reacts to the announcement early.
			// Its attachment-draining claim releases these counts once work settles.
			if (opens) await Promise.all([...opens]);
			this.releasedConnections.delete(connectionId);
			this.pendingCapabilities.delete(connectionId);
			return;
		}
		if (owned === undefined) {
			if (opens) await Promise.all([...opens]);
			this.releasedConnections.delete(connectionId);
			this.pendingCapabilities.delete(connectionId);
			return;
		}
		await Promise.all(
			[...owned].map(async ([sessionId, count]) => {
				for (let attachment = 0; attachment < count; attachment++) {
					// Headless completion contract: a turn survives its client's death and
					// runs to settlement (the host lifecycle keeps the process alive on
					// active turns even with zero connections). Releasing mid-turn aborts
					// the run and seals the session before agent_settled reaches the
					// lifecycle observer, leaking the busy counter so the host never
					// idle-exits. Defer - never skip - the release until the turn settles,
					// so the dropped owner's reservation still frees afterwards.
					//
					// A retained session is never closed by a drop, so it has nothing to defer:
					// release the attachment now - the client is already gone and must not keep
					// counting - and let the turn run to settlement on its own.
					const live = this.registry.peek(sessionId);
					const retained = live?.retainOnDisconnect === true;
					const session = live?.state === "open" ? live.runtime?.session : undefined;
					if (!retained && live?.state === "open" && live.worker?.snapshot?.streaming) {
						const unsubscribe = live.worker.subscribeSettled(() => {
							unsubscribe();
							void this.releaseOwnedSession(sessionId).catch((cause: unknown) => {
								process.stderr.write(
									`senpi rpc deferred worker release ${sessionId} failed: ${String(cause)}\n`,
								);
							});
						});
						continue;
					}
					if (!retained && session?.isStreaming) {
						let released = false;
						const unsubscribe = session.subscribe((event) => {
							if (event.type !== "agent_settled" && event.type !== "agent_idle") return;
							if (released) return;
							released = true;
							unsubscribe();
							void this.releaseOwnedSession(sessionId).catch((cause) => {
								process.stderr.write(
									`senpi rpc deferred release for session ${sessionId} failed: ${String(cause)}\n`,
								);
							});
						});
						continue;
					}
					await this.releaseOwnedSession(sessionId);
				}
			}),
		);
		if (opens) await Promise.all([...opens]);
		this.releasedConnections.delete(connectionId);
		this.pendingCapabilities.delete(connectionId);
	}

	/**
	 * One owned handle's refcounted close: the same sequence as an explicit
	 * close_session, tolerant of races with other lifecycle paths (an entry
	 * already closed or claimed elsewhere is simply skipped), except that it claims
	 * a DETACH: a retained entry keeps running at zero attachments instead of
	 * closing, so this path releases the client's claim without ending the session.
	 * Disposal, pending
	 * extension-UI cancellation and binding removal happen only when this was the
	 * LAST attachment (the entry transitioned to "closing"): surviving
	 * attachments keep the shared binding and their event stream.
	 */
	private async releaseOwnedSession(sessionId: string): Promise<void> {
		const live = this.registry.peek(sessionId);
		const parks = live?.state === "open" && live.retainOnDisconnect === true && live.attachments === 1;
		// A failed claim means the entry is already closed or owned by another path.
		// A retained entry answers the detach by staying open: no finalizer, nothing to join.
		const claim = this.tryClaimClose(sessionId, { drainAttachments: false, detach: true });
		if (!claim) return;
		if (!claim.finalizer) {
			if (parks && live.runtime) {
				live.lifecycleMutex = live.lifecycleMutex.then(() => live.runtime?.emitAttachmentEvent("session_parked"));
				await live.lifecycleMutex;
			}
			await this.finalizations.get(sessionId)?.promise;
			return;
		}
		const binding = this.bindings.get(sessionId);
		// Pending UI requests are session-owned, not connection-owned: a question
		// asked through one connection stays answerable by every other attachment.
		// Cancel them only here, where the refcount has already decided the session
		// is being torn down, never on any owner drop.
		binding?.cancelPendingExtensionUiRequests?.();
		await this.finalizeClose(sessionId, binding);
	}

	/**
	 * Releases one attachment (or every attachment when draining) and reports
	 * whether this caller became the finalizer. The join token is installed inside
	 * the registry callback, before any await, so a close that lands between the
	 * claim and finalizeClose() always finds a token to wait on instead of
	 * answering ahead of the terminal records.
	 */
	private claimClose(sessionId: string, options: CloseClaimOptions): { finalizer: boolean } {
		let finalizer = true;
		const onRole = (isFinalizer: boolean): void => {
			finalizer = isFinalizer;
			if (isFinalizer && !this.finalizations.has(sessionId))
				this.finalizations.set(sessionId, this.createFinalization());
		};
		let entry = this.registry.beginClose(sessionId, onRole, { detach: options.detach });
		while (options.drainAttachments && entry.state === "open") entry = this.registry.beginClose(sessionId, onRole);
		return { finalizer: finalizer && entry.state === "closing" };
	}

	/** claimClose() for lifecycle paths that treat a lost race as "nothing to do". */
	private tryClaimClose(sessionId: string, options: CloseClaimOptions): { finalizer: boolean } | undefined {
		try {
			return this.claimClose(sessionId, options);
		} catch {
			return undefined;
		}
	}

	private async close(command: Extract<RpcCommand, { type: "close_session" }>): Promise<RpcResponse | undefined> {
		const response = {
			id: command.id,
			type: "response" as const,
			command: "close_session" as const,
			success: true as const,
			data: {},
		};
		// A close releases the CALLER's attachment, and routing handles are public on a
		// shared host (`list_sessions` publishes every one of them), so ownership - not
		// knowledge of the handle - authorizes it: a connection that never attached holds
		// no attachment, and answering it would release another client's claim and could
		// tear down a session it never opened. A host with no per-connection identity
		// (stdio) has no ownership to check and keeps answering every close as before.
		const owner = this.writer.currentConnection();
		if (owner !== undefined && this.sessionsByConnection.get(owner)?.has(command.sessionId) !== true)
			return error(command.id, "close_session", RPC_ERROR_UNKNOWN_SESSION);
		const reply = this.writer.reserveCloseResponse(command.sessionId, response);
		if (!reply) return undefined;
		// Admission and claiming are synchronous, before any teardown await. A
		// saturated requester neither releases an attachment nor joins a promise.
		let claim: { finalizer: boolean };
		try {
			claim = this.claimClose(command.sessionId, { drainAttachments: false });
		} catch (cause) {
			reply.release();
			return error(command.id, "close_session", this.code(cause));
		}
		try {
			if (owner !== undefined) this.releaseOwnerAttachment(owner, command.sessionId);
			if (claim.finalizer) {
				await this.finalizeClose(command.sessionId, this.bindings.get(command.sessionId), () =>
					reply.complete(true, "client_close"),
				);
			} else {
				await this.finalizations.get(command.sessionId)?.promise;
				reply.complete(false);
			}
			return undefined;
		} finally {
			reply.release();
		}
	}

	/** Detaches the closing connection's UI/width state; a rerender failure must not abort the close. */
	private releaseOwnerAttachment(owner: string, sessionId: string): void {
		const widths = this.widths.get(sessionId);
		widths?.delete(owner);
		if (widths?.size === 0) this.widths.delete(sessionId);
		this.writer.detachConnectionFromSession(owner, sessionId);
		for (const binding of this.bindings.values()) {
			try {
				binding.rerenderComponents?.();
			} catch (cause) {
				process.stderr.write(`senpi rpc rerender after close of session ${sessionId} failed: ${String(cause)}\n`);
			}
		}
		const owned = this.sessionsByConnection.get(owner);
		const count = owned?.get(sessionId);
		if (!owned || count === undefined) return;
		if (count === 1) owned.delete(sessionId);
		else owned.set(sessionId, count - 1);
		if (owned.size === 0) this.sessionsByConnection.delete(owner);
	}

	/**
	 * Runs the finalizer side of a close for a handle whose beginClose() made this
	 * caller the owner: dispose the binding, complete the registry teardown, emit
	 * the terminal records, then release joiners. Every step is guarded so the join
	 * token always resolves and a failing binding yields one logged line, never a
	 * second response or an escaped rejection.
	 */
	private async finalizeClose(
		sessionId: string,
		binding: RpcSessionBinding | undefined,
		terminal?: () => void,
	): Promise<void> {
		const finalization = this.finalizations.get(sessionId) ?? this.createFinalization();
		this.finalizations.set(sessionId, finalization);
		try {
			try {
				await binding?.dispose();
			} catch (cause) {
				process.stderr.write(`senpi rpc binding dispose for session ${sessionId} failed: ${String(cause)}\n`);
			}
			this.bindings.delete(sessionId);
			try {
				await this.registry.closeMarked(sessionId);
			} catch (cause) {
				process.stderr.write(`senpi rpc close for session ${sessionId} failed: ${String(cause)}\n`);
			}
			// closeMarked may return at the grace deadline while ownership remains;
			// terminal records must still observe the exit callback's registry removal.
			await this.registry.peek(sessionId)?.closeCompletion;
			terminal?.();
			// The binding is silent and the runtime has relinquished this unique
			// handle. Queued terminal records survive forgetting its bookkeeping.
			this.forgetSessionOwnership(sessionId);
			this.writer.forgetSession(sessionId);
		} finally {
			finalization.resolve();
			this.finalizations.delete(sessionId);
		}
	}

	private createFinalization(): { promise: Promise<void>; resolve: () => void } {
		let resolveFinalization: (() => void) | undefined;
		const promise = new Promise<void>((resolve) => {
			resolveFinalization = resolve;
		});
		return { promise, resolve: () => resolveFinalization?.() };
	}

	/** The machine-readable half of a refusal, when the registry attached one. */
	private detail(cause: unknown): Readonly<Record<string, unknown>> | undefined {
		return cause instanceof RpcSessionRegistryError ? cause.detail : undefined;
	}

	private code(cause: unknown): string {
		if (cause instanceof RpcSessionRegistryError) {
			return cause.code === RPC_ERROR_OPEN_FAILED ? cause.message : cause.code;
		}
		if (cause instanceof Error && [RPC_ERROR_UNKNOWN_SESSION, RPC_ERROR_SESSION_CLOSING].includes(cause.message)) {
			return cause.message;
		}
		return cause instanceof Error && cause.message
			? `${RPC_ERROR_OPEN_FAILED}: ${cause.message}`
			: RPC_ERROR_UNKNOWN_SESSION;
	}
}
