import { isAbsolute } from "node:path";
import { assertValidSessionId } from "../../core/session-manager.ts";
import { createRegistryWarm, type HostWarm, waitForWarms } from "./host-warm.ts";
import { refreshesSessionActivity } from "./session-command-activity.ts";
import { publishedSessionContext } from "./session-context-patch.ts";
import { attachLiveSession, markPathAttached } from "./session-live-attachment.ts";
import { beginPendingClaim, type PendingClaims, syncRuntimeMetadata } from "./session-registry-claims.ts";
import { openRegistrySession } from "./session-registry-open.ts";
import type { SessionStatusFanoutView } from "./session-status.ts";
import { sessionRowStatusFields } from "./session-status-source.ts";

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
	readonly supportsCompact: (profile?: RpcSessionLaunchProfile) => boolean;
	readonly supportsParkClaim = true;
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
	private readonly warmsInFlight?: (cwd: string) => Promise<void> | undefined;

	/** The agent directory this host keeps its sessions (and session-move folders) under. */
	get agentDir(): string {
		return this.options.agentDir;
	}

	constructor(options: RpcSessionRegistryOptions) {
		if (options.createRuntime.prepare) {
			const warming = createRegistryWarm(options.createRuntime.prepare, {
				agentDir: options.agentDir,
				...(options.mcpRegistry !== undefined ? { mcpRegistry: options.mcpRegistry } : {}),
			});
			this.warm = warming.warm;
			this.warmsInFlight = warming.inFlight;
		}
		this.options =
			options.mcpRegistry === undefined
				? options
				: {
						...options,
						createRuntime: (runtimeOptions) =>
							options.createRuntime({ ...runtimeOptions, mcpRegistry: options.mcpRegistry }),
					};
		this.supportsCompact = options.createRuntime.supportsCompact ?? (() => false);
		this.now = options.now ?? Date.now;
		this.closeGraceMs = options.closeGraceMs ?? 10_000;
		this.teardownHost = {
			closeGraceMs: this.closeGraceMs,
			get: (handle) => this.entries.get(handle),
			delete: (handle) => {
				const speculative = this.entries.get(handle)?.speculative;
				const deleted = this.entries.delete(handle);
				if (!speculative) this.options.onSizeChange?.(this.size);
				return deleted;
			},
			releaseReservation: async (key) => {
				// Close may finish at its grace deadline before removal settles. Keep
				// that work visible to reopen even after the closing entry is gone. A failed removal
				// still gives the path back: no entry is left to ever release it later.
				const settle = beginPendingClaim(this.pendingClaims, key);
				try {
					await this.options.pathReservations?.release(key);
				} finally {
					this.reservations.delete(key);
					settle();
				}
			},
			markDetached: (key) => this.options.pathReservations?.setAttached(key, false),
			now: () => this.now(),
			sync: () => this.syncRuntimeMetadata(),
		};
	}

	/** Number of live entries, including ones still opening or closing. */
	get size(): number {
		return [...this.entries.values()].filter((entry) => !entry.speculative).length;
	}

	/** Commit the ledger's exclusive claim after its existing runtime has acquired a persistent file. */
	async claimPark(handle: string, retainOnDisconnect: boolean): Promise<OpenRpcSession> {
		const entry = this.entries.get(handle);
		if (!entry?.speculative || entry.state !== "open" || !entry.runtime)
			throw new RpcSessionRegistryError("unknown_session");
		await entry.runtime.persistSession();
		// No await between the duplicate decision and publication: an ordinary open may have
		// reserved this identity while persistence was being enabled.
		for (const other of this.entries.values())
			if (!other.speculative && other.durableSessionId === entry.runtime.session.sessionId)
				throw new RpcSessionRegistryError("session_id_in_use");
		entry.speculative = false;
		entry.attachments = 1;
		entry.retainOnDisconnect = retainOnDisconnect;
		entry.lastCommandAt = this.now();
		this.syncRuntimeMetadata();
		this.options.onSizeChange?.(this.size);
		return { sessionId: handle, durableSessionId: entry.runtime.session.sessionId, sessionPath: entry.sessionPath };
	}

	/** Daemon-family identities come from the endpoint's claims and generation registry. */
	holderPids(observedStarts?: ReadonlyMap<number, number | undefined>): Promise<readonly number[]> {
		return this.options.pathReservations?.holderPids?.(observedStarts) ?? Promise.resolve([]);
	}

	openSession(requested: RpcSessionLaunchProfile, options?: RpcSessionOpenOptions): Promise<OpenRpcSession> {
		// A warm in flight (the boot load of senpi#6147 included) loads on this loop and yields it between modules
		// (senpi#6199): an open builds its runtime after the warms of ITS cwd that are loading when it arrives, so
		// its factories never run beside that load. Other cwds and later warms are not waited on, and the wait is
		// bounded by `closeGraceMs` like the closing-reservation wait.
		const warming = this.warmsInFlight?.(requested.cwd);
		if (warming === undefined) return this.openNow(requested, options);
		return waitForWarms(warming, this.closeGraceMs, requested.cwd).then(() => this.openNow(requested, options));
	}

	private openNow(requested: RpcSessionLaunchProfile, options?: RpcSessionOpenOptions): Promise<OpenRpcSession> {
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

	/** `fanoutOf` is the status stream's fanout view, so a row's `activity` reads what `session_status` reads. */
	list(fanoutOf?: (sessionId: string) => SessionStatusFanoutView): RpcSessionRow[] {
		this.syncRuntimeMetadata();
		const now = this.now();
		return [...this.entries]
			.filter(([, entry]) => !entry.speculative)
			.map(([sessionId, entry]) => ({
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
				...sessionRowStatusFields(entry, fanoutOf?.(sessionId)),
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
