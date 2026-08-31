import { VERSION } from "../../config.ts";
import { buildRpcSessionState } from "./connection-handler.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import {
	RPC_ERROR_MISSING_SESSION_ID,
	RPC_ERROR_OPEN_FAILED,
	RPC_ERROR_SESSION_CLOSING,
	RPC_ERROR_UNKNOWN_SESSION,
} from "./rpc-types.ts";
import { createRpcSessionBinding, type RpcSessionBinding } from "./session-binding.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import type {
	OpenRpcSession,
	RpcSessionEntry,
	RpcSessionLaunchProfile,
	RpcSessionRegistry,
} from "./session-registry.ts";
import { RpcSessionRegistryError } from "./session-registry.ts";

const controls = new Set(["get_protocol_info", "open_session", "close_session", "list_sessions"]);

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

	constructor(
		registry: RpcSessionRegistry,
		writer: SessionEventWriter,
		defaults: Pick<RpcSessionLaunchProfile, "cwd" | "permissionPreset" | "creationModel" | "initialThinkingLevel">,
		createBinding: typeof createRpcSessionBinding = createRpcSessionBinding,
		connectionOptions: Parameters<typeof createRpcSessionBinding>[4] = {},
	) {
		this.registry = registry;
		this.writer = writer;
		this.defaults = defaults;
		this.createBinding = createBinding;
		this.connectionOptions = connectionOptions;
	}

	async handle(command: RpcCommand): Promise<RpcResponse | undefined> {
		if (command.type === "get_protocol_info") {
			const capabilities = new Set(["multi_session", ...(this.connectionOptions?.capabilities ?? [])]);
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
		await Promise.all(
			[...this.bindings.entries()].map(async ([sessionId, binding]) => {
				let entry: RpcSessionEntry | undefined;
				try {
					entry = this.registry.beginClose(sessionId);
				} catch {
					return;
				}
				try {
					if (entry.state === "open") {
						while (entry.state === "open") entry = this.registry.beginClose(sessionId);
					}
					await binding.dispose();
				} finally {
					this.bindings.delete(sessionId);
					if (entry.state === "closing") await this.registry.closeMarked(sessionId);
				}
			}),
		);
		this.bindings.clear();
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
									? (this.pendingCapabilities.get(owner) ?? [])
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
		let entry: RpcSessionEntry | undefined;
		try {
			entry = this.registry.beginClose(sessionId);
		} catch {
			// Already closed or claimed by another lifecycle path; nothing to release.
			return;
		}
		try {
			if (entry.state === "closing") await this.bindings.get(sessionId)?.dispose();
		} finally {
			if (entry.state === "closing") {
				this.bindings.delete(sessionId);
				await this.registry.closeMarked(sessionId);
			}
		}
	}

	private async close(command: Extract<RpcCommand, { type: "close_session" }>): Promise<RpcResponse | undefined> {
		try {
			// This must be the first operation: binding.dispose() awaits teardown and
			// otherwise leaves a window where commands can enter the old handler.
			const entry = this.registry.beginClose(command.sessionId);
			const owner = this.writer.currentConnection();
			if (owner !== undefined) {
				this.widths.get(command.sessionId)?.delete(owner);
				this.writer.detachConnectionFromSession(owner, command.sessionId);
				for (const binding of this.bindings.values()) binding.rerenderComponents?.();
			}
			if (owner !== undefined) {
				const owned = this.sessionsByConnection.get(owner);
				const count = owned?.get(command.sessionId);
				if (owned && count !== undefined) {
					if (count === 1) owned.delete(command.sessionId);
					else owned.set(command.sessionId, count - 1);
					if (owned.size === 0) this.sessionsByConnection.delete(owner);
				}
			}
			const response = {
				id: command.id,
				type: "response" as const,
				command: "close_session" as const,
				success: true as const,
				data: {},
			};
			try {
				if (entry.state === "closing") await this.bindings.get(command.sessionId)?.dispose();
			} finally {
				if (entry.state === "closing") {
					this.bindings.delete(command.sessionId);
					await this.registry.closeMarked(command.sessionId);
					this.writer.closeSession(command.sessionId, response);
				} else {
					this.writer.enqueue(command.sessionId, response);
				}
			}
			return undefined;
		} catch (cause) {
			return error(command.id, "close_session", this.code(cause));
		}
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
