import { isAbsolute } from "node:path";
import { assertValidSessionId } from "../../core/session-manager.ts";
import { createRegistryWarm, type HostWarm } from "./host-warm.ts";
import { refreshesSessionActivity } from "./session-command-activity.ts";
import { publishedSessionContext } from "./session-context-patch.ts";
import { attachLiveSession, markPathAttached } from "./session-live-attachment.ts";
import { type PendingClaims, syncRuntimeMetadata } from "./session-registry-claims.ts";
import { openRegistrySession } from "./session-registry-open.ts";

import {
	type OpenRpcSession,
	type RpcSessionEntry,
	type RpcSessionLaunchProfile,
	type RpcSessionOpenOptions,
	RpcSessionRegistryError,
	type RpcSessionRegistryOptions,
	type RpcSessionRow,
} from "./session-registry-types.ts";
import { beginSessionClose, closeMarkedSession, closeSession, type SessionTeardownHost } from "./session-teardown.ts";

export {
	frozenProfile,
	type OpenRpcSession,
	type RpcSessionEntry,
	type RpcSessionLaunchProfile,
	type RpcSessionOpenOptions,
	RpcSessionRegistryError,
	type RpcSessionRegistryOptions,
	type RpcSessionRow,
	type RpcSessionState,
	type SessionRuntime,
	sessionIdentity,
} from "./session-registry-types.ts";

/** Process-local lifecycle owner for multi-session RPC runtimes. */
export class RpcSessionRegistry {
	private readonly entries = new Map<string, RpcSessionEntry>();
	private readonly reservations = new Set<string>();
	private readonly pendingClaims: PendingClaims = new Map();
	private readonly teardownHost: SessionTeardownHost;
	private nextHandle = 0;
	private readonly options: RpcSessionRegistryOptions;
	private readonly now: () => number;
	readonly closeGraceMs: number;
	/** Present only when the runtime factory can build a session's services alone (`host-warm.ts`). */
	readonly warm?: HostWarm;

	/** The agent directory this host keeps its sessions (and session-move folders) under. */
	get agentDir(): string {
		return this.options.agentDir;
	}

	constructor(options: RpcSessionRegistryOptions) {
		if (options.createRuntime.prepare)
			this.warm = createRegistryWarm(options.createRuntime.prepare, {
				agentDir: options.agentDir,
				...(options.mcpRegistry !== undefined ? { mcpRegistry: options.mcpRegistry } : {}),
			});
		this.options =
			options.mcpRegistry === undefined
				? options
				: {
						...options,
						createRuntime: (runtimeOptions) =>
							options.createRuntime({ ...runtimeOptions, mcpRegistry: options.mcpRegistry }),
					};
		this.now = options.now ?? Date.now;
		this.closeGraceMs = options.closeGraceMs ?? 10_000;
		this.teardownHost = {
			closeGraceMs: this.closeGraceMs,
			get: (handle) => this.entries.get(handle),
			delete: (handle) => {
				const deleted = this.entries.delete(handle);
				this.options.onSizeChange?.(this.entries.size);
				return deleted;
			},
			releaseReservation: async (key) => {
				await this.options.pathReservations?.release(key);
				this.reservations.delete(key);
			},
			markDetached: (key) => this.options.pathReservations?.setAttached(key, false),
			now: () => this.now(),
			sync: () => this.syncRuntimeMetadata(),
		};
	}

	/** Number of live entries, including ones still opening or closing. */
	get size(): number {
		return this.entries.size;
	}

	/** Daemon-family identities come from the endpoint's claims and generation registry. */
	holderPids(observedStarts?: ReadonlyMap<number, number | undefined>): Promise<readonly number[]> {
		return this.options.pathReservations?.holderPids?.(observedStarts) ?? Promise.resolve([]);
	}

	openSession(requested: RpcSessionLaunchProfile, options?: RpcSessionOpenOptions): Promise<OpenRpcSession> {
		return openRegistrySession(
			{
				entries: this.entries,
				reservations: this.reservations,
				pendingClaims: this.pendingClaims,
				options: this.options,
				teardownHost: this.teardownHost,
				closeGraceMs: this.closeGraceMs,
				now: this.now,
				nextHandle: () => `rpc-${++this.nextHandle}`,
				validateProfile: (profile) => this.validateProfile(profile),
				syncRuntimeMetadata: () => this.syncRuntimeMetadata(),
			},
			requested,
			options,
		);
	}

	/**
	 * Read-only lookup with no state transitions or attachment accounting.
	 * Exists so lifecycle decisions (e.g. deferring a dropped connection's
	 * release while a turn is still streaming) can inspect the live entry
	 * without claiming it.
	 */
	peek(handle: string): RpcSessionEntry | undefined {
		return this.entries.get(handle);
	}

	attachSession(handle: string): RpcSessionEntry {
		const entry = this.entries.get(handle);
		return attachLiveSession(entry, this.now(), () => markPathAttached(entry, this.options.pathReservations));
	}

	getForCommand(handle: string, command: string): RpcSessionEntry {
		const entry = this.entries.get(handle);
		if (!entry) throw new RpcSessionRegistryError("unknown_session");
		if (
			entry.state === "closing" &&
			!["abort", "abort_bash", "extension_ui_response", "extension_ui_progress", "host_response"].includes(command)
		) {
			throw new RpcSessionRegistryError("session_closing");
		}
		if (entry.state !== "open" && entry.state !== "closing") throw new RpcSessionRegistryError("unknown_session");
		// Polling a session nobody holds is observation, not work that needs its runtime;
		// an attached client's polling keeps its session alive exactly as before.
		if (entry.attachments > 0 || refreshesSessionActivity(command)) entry.lastCommandAt = this.now();
		return entry;
	}

	/**
	 * Starts a close synchronously and returns the live entry for routing decisions.
	 * `detach` marks a client going away rather than the session ending, which a
	 * retained entry answers by staying open at zero attachments.
	 */
	beginClose(handle: string, onRole?: (finalizer: boolean) => void, options?: { detach?: boolean }): RpcSessionEntry {
		return beginSessionClose(this.teardownHost, handle, onRole, options);
	}

	async close(handle: string): Promise<void> {
		return closeSession(this.teardownHost, handle);
	}

	/** Completes a close previously made visible by beginClose(). */
	async closeMarked(handle: string): Promise<void> {
		return closeMarkedSession(this.teardownHost, handle);
	}

	list(): RpcSessionRow[] {
		this.syncRuntimeMetadata();
		const now = this.now();
		return [...this.entries].map(([sessionId, entry]) => ({
			sessionId,
			durableSessionId: entry.durableSessionId,
			sessionPath: entry.sessionPath,
			cwd: entry.cwd,
			name: entry.runtime?.session.sessionManager.getSessionName(),
			kind: entry.kind,
			context: publishedSessionContext(entry.context, entry.contextOverlay),
			// A closing entry has already released its last attachment; never publish that as negative.
			attachments: Math.max(0, entry.attachments),
			retain_on_disconnect: entry.retainOnDisconnect === true,
			status: entry.state === "quarantined" ? "closing" : entry.state,
			idleMs: Math.max(0, now - entry.lastCommandAt),
			tool_child: entry.runtime?.session.toolChildRow() ?? { state: "none" },
		}));
	}

	private syncRuntimeMetadata(): void {
		syncRuntimeMetadata(this.entries.values(), this.reservations, this.options.pathReservations);
	}

	private validateProfile(profile: RpcSessionLaunchProfile): void {
		if (!isAbsolute(profile.cwd) || (profile.sessionPath !== undefined && !isAbsolute(profile.sessionPath))) {
			throw new RpcSessionRegistryError("invalid_path");
		}
		if (profile.durableSessionId !== undefined) {
			try {
				assertValidSessionId(profile.durableSessionId);
			} catch (cause) {
				throw new RpcSessionRegistryError("invalid_session_id", String(cause));
			}
		}
	}
}
