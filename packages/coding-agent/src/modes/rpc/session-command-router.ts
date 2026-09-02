import { VERSION } from "../../config.ts";
import { buildRpcSessionState } from "./connection-handler.ts";
import { AUTO_TITLE_SESSIONS_CAPABILITY } from "./custom-capability.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import {
	RPC_ERROR_MISSING_SESSION_ID,
	RPC_ERROR_OPEN_FAILED,
	RPC_ERROR_SESSION_CLOSING,
	RPC_ERROR_UNKNOWN_SESSION,
} from "./rpc-types.ts";
import { createRpcSessionBinding, type RpcSessionBinding } from "./session-binding.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import type { OpenRpcSession, RpcSessionLaunchProfile, RpcSessionRegistry } from "./session-registry.ts";
import { RpcSessionRegistryError } from "./session-registry.ts";

const controls = new Set(["get_protocol_info", "open_session", "close_session", "list_sessions"]);

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
	/**
	 * Consulted every tick before the empty-exit window advances. Returning false
	 * both blocks the exit and resets the window, so a host with a connected but
	 * sessionless client stays up instead of exiting under its supervisor.
	 */
	canExitWhenEmpty?: () => boolean;
}

function error(id: string | undefined, command: string, code: string): RpcResponse {
	return { id, type: "response", command, success: false, error: code };
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
	private readonly registry: RpcSessionRegistry;
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
	private emptySince: number | undefined;

	constructor(
		registry: RpcSessionRegistry,
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
		this.canExitWhenEmpty = idle?.canExitWhenEmpty;
		if (Number.isFinite(this.idleEvictionMs) || Number.isFinite(this.emptyExitMs)) {
			// Unref'd: occupancy hygiene must never be the reason the event loop stays open.
			const tickMs = Math.max(20, Math.min(5_000, Math.min(this.idleEvictionMs, this.emptyExitMs) / 4));
			this.sweepTimer = setInterval(() => this.sweepIdleSessions(), tickMs);
			this.sweepTimer.unref?.();
		}
	}

	async handle(command: RpcCommand): Promise<RpcResponse | undefined> {
		if (command.type === "get_protocol_info") {
			const capabilities = new Set([
				"multi_session",
				AUTO_TITLE_SESSIONS_CAPABILITY,
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
				},
			};
		}
		if (command.type === "list_sessions")
			return {
				id: command.id,
				type: "response",
				command: "list_sessions",
				success: true,
				data: { sessions: this.registry.list() },
			};
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
		if (controls.has(command.type)) return undefined;
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
		this.stopSweep();
		await Promise.all(
			[...this.bindings.entries()].map(async ([sessionId, binding]) => {
				const claim = this.tryClaimClose(sessionId, { drainAttachments: true });
				if (!claim) return;
				if (claim.finalizer) await this.finalizeClose(sessionId, binding);
				else await this.finalizations.get(sessionId)?.promise;
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
	 * never killed. Fires onEmptyExit once the registry has STAYED empty for
	 * emptyExitMs with the exit permitted; any live session or connected client
	 * resets that window. Runs on an unref'd interval and is safe to call directly.
	 */
	sweepIdleSessions(): void {
		const now = this.idleNow();
		if (Number.isFinite(this.idleEvictionMs)) {
			for (const { sessionId, status } of this.registry.list()) {
				if (status !== "open") continue;
				const entry = this.registry.peek(sessionId);
				if (!entry) continue;
				if (entry.runtime?.session.isSessionBusy) {
					// Session-owned work defers eviction; the window restarts when it settles.
					entry.lastCommandAt = now;
					continue;
				}
				if (now - entry.lastCommandAt >= this.idleEvictionMs) void this.evictIdleSession(sessionId);
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
	 */
	private async evictIdleSession(sessionId: string): Promise<void> {
		// A failed claim means an explicit close raced us and owns the entry now.
		const claim = this.tryClaimClose(sessionId, { drainAttachments: true });
		if (!claim) return;
		const binding = this.bindings.get(sessionId);
		binding?.cancelPendingExtensionUiRequests?.();
		this.forgetSessionOwnership(sessionId);
		if (claim.finalizer) {
			await this.finalizeClose(sessionId, binding, () =>
				this.writer.closeSession(sessionId, {
					type: "response",
					command: "close_session",
					success: true,
					data: {},
				}),
			);
		} else {
			await this.finalizations.get(sessionId)?.promise;
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
		opens.add(barrier);
		this.opensByConnection.set(owner, opens);
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
		let opened: OpenRpcSession | undefined;
		try {
			opened = await this.registry.openSession({
				cwd: command.cwd ?? this.defaults.cwd,
				sessionPath: command.sessionPath,
				permissionPreset: command.permissionPreset ?? this.defaults.permissionPreset,
				creationModel:
					command.provider && command.modelId
						? { provider: command.provider, modelId: command.modelId }
						: this.defaults.creationModel,
				initialThinkingLevel: command.thinkingLevel ?? this.defaults.initialThinkingLevel,
			});
			const openedSession = opened;
			const entry = this.registry.getForCommand(openedSession.sessionId, "open_session");
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
			}
			if (owner !== undefined && this.releasedConnections.has(owner)) {
				await this.releaseOwnedSession(openedSession.sessionId);
			}
			const state = entry.runtime!.session;
			this.writer.enqueue(opened.sessionId, {
				id: command.id,
				type: "response",
				command: "open_session",
				success: true,
				data: {
					sessionId: opened.sessionId,
					state: buildRpcSessionState(state),
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
			return error(command.id, "open_session", this.code(cause));
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
		for (const widths of this.widths.values()) widths.delete(connectionId);
		for (const binding of this.bindings.values()) binding.rerenderComponents?.();
		const opens = this.opensByConnection.get(connectionId);
		if (opens) await Promise.all([...opens]);
		const owned = this.sessionsByConnection.get(connectionId);
		this.sessionsByConnection.delete(connectionId);
		if (owned === undefined) {
			this.releasedConnections.delete(connectionId);
			return;
		}
		for (const [sessionId, count] of owned) {
			this.bindings.get(sessionId)?.cancelPendingExtensionUiRequests?.();
			for (let attachment = 0; attachment < count; attachment++) {
				// Headless completion contract: a turn survives its client's death and
				// runs to settlement (the host lifecycle keeps the process alive on
				// active turns even with zero connections). Releasing mid-turn aborts
				// the run and seals the session before agent_settled reaches the
				// lifecycle observer, leaking the busy counter so the host never
				// idle-exits. Defer - never skip - the release until the turn settles,
				// so the dropped owner's reservation still frees afterwards.
				const live = this.registry.peek(sessionId);
				const session = live?.state === "open" ? live.runtime?.session : undefined;
				if (session?.isStreaming) {
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
		}
		this.releasedConnections.delete(connectionId);
	}

	/**
	 * One owned handle's refcounted close: the same sequence as an explicit
	 * close_session, tolerant of races with other lifecycle paths (an entry
	 * already closed or claimed elsewhere is simply skipped). Disposal and
	 * binding removal happen only when this was the LAST attachment (the entry
	 * transitioned to "closing"): surviving attachments keep the shared binding
	 * and their event stream.
	 */
	private async releaseOwnedSession(sessionId: string): Promise<void> {
		// A failed claim means the entry is already closed or owned by another path.
		const claim = this.tryClaimClose(sessionId, { drainAttachments: false });
		if (!claim) return;
		if (claim.finalizer) await this.finalizeClose(sessionId, this.bindings.get(sessionId));
		else await this.finalizations.get(sessionId)?.promise;
	}

	/**
	 * Releases one attachment (or every attachment when draining) and reports
	 * whether this caller became the finalizer. The join token is installed inside
	 * the registry callback, before any await, so a close that lands between the
	 * claim and finalizeClose() always finds a token to wait on instead of
	 * answering ahead of the terminal records.
	 */
	private claimClose(sessionId: string, options: { drainAttachments: boolean }): { finalizer: boolean } {
		let finalizer = true;
		const onRole = (isFinalizer: boolean): void => {
			finalizer = isFinalizer;
			if (isFinalizer && !this.finalizations.has(sessionId))
				this.finalizations.set(sessionId, this.createFinalization());
		};
		let entry = this.registry.beginClose(sessionId, onRole);
		while (options.drainAttachments && entry.state === "open") entry = this.registry.beginClose(sessionId, onRole);
		return { finalizer: finalizer && entry.state === "closing" };
	}

	/** claimClose() for lifecycle paths that treat a lost race as "nothing to do". */
	private tryClaimClose(
		sessionId: string,
		options: { drainAttachments: boolean },
	): { finalizer: boolean } | undefined {
		try {
			return this.claimClose(sessionId, options);
		} catch {
			return undefined;
		}
	}

	private async close(command: Extract<RpcCommand, { type: "close_session" }>): Promise<RpcResponse | undefined> {
		// This must be the first operation: binding.dispose() awaits teardown and
		// otherwise leaves a window where commands can enter the old handler.
		let claim: { finalizer: boolean };
		try {
			claim = this.claimClose(command.sessionId, { drainAttachments: false });
		} catch (cause) {
			return error(command.id, "close_session", this.code(cause));
		}
		const response = {
			id: command.id,
			type: "response" as const,
			command: "close_session" as const,
			success: true as const,
			data: {},
		};
		const owner = this.writer.currentConnection();
		if (owner !== undefined) this.releaseOwnerAttachment(owner, command.sessionId);
		if (claim.finalizer) {
			await this.finalizeClose(command.sessionId, this.bindings.get(command.sessionId), () =>
				this.writer.closeSession(command.sessionId, response),
			);
		} else {
			await this.finalizations.get(command.sessionId)?.promise;
			this.writer.enqueueClosedResponse(command.sessionId, response);
		}
		return undefined;
	}

	/** Detaches the closing connection's UI/width state; a rerender failure must not abort the close. */
	private releaseOwnerAttachment(owner: string, sessionId: string): void {
		this.widths.get(sessionId)?.delete(owner);
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
			terminal?.();
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
