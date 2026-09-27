import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import {
	type AgentSessionLaunchProfile,
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.ts";
import type { HostMcpRegistry } from "../../core/extensions/builtin/mcp/host-registry.ts";
import type { SessionContext, SessionKind, SessionStartEvent } from "../../core/extensions/types.ts";
import { EMPTY_SESSION_CONTEXT } from "../../core/extensions/types.ts";
import { assertValidSessionId, SessionManager } from "../../core/session-manager.ts";
import { SESSION_PATH_RETRY_AFTER_MS, type SessionPathReservations } from "./host-reservations.ts";
import { canonicalSessionPath } from "./session-path-key.ts";
import { beginSessionClose, closeMarkedSession, closeSession, type SessionTeardownHost } from "./session-teardown.ts";
import type { SessionWorkerClient } from "./session-worker-client.ts";

/** The immutable flags selected when a routing session is opened. */
export interface RpcSessionLaunchProfile extends AgentSessionLaunchProfile {
	sessionPath?: string;
	/**
	 * Durable session id chosen by the caller, applied ONLY when this open creates the session.
	 * An existing session file keeps the id in its header, so a resume never rewrites identity.
	 */
	durableSessionId?: string;
}

export type SessionRuntime = AgentSessionRuntime;
export type RpcSessionState = "opening" | "open" | "closing" | "quarantined" | "closed";

export interface RpcSessionEntry {
	state: RpcSessionState;
	runtime?: SessionRuntime;
	worker?: SessionWorkerClient;
	/** Visibility class chosen by the open, frozen for the entry's life. */
	readonly kind: SessionKind;
	/** Frozen opaque labels the open attached; `{}` when it attached none. */
	readonly context: SessionContext;
	/** Resolves replacement against the runtime currently owned by this entry. */
	switchSession?: SessionRuntime["switchSession"];
	/** Rebind callback installed by the shared RPC connection handler. */
	rebindSession?: Parameters<SessionRuntime["setRebindSession"]>[0];
	scope: ProviderScope;
	profile: Readonly<RpcSessionLaunchProfile>;
	durableSessionId?: string;
	sessionPath?: string;
	/** Canonical reservation key for path-opened sessions; matches the reservations set. */
	reservationKey?: string;
	/** Key granted for the spelling this session was opened with; cleared once superseded. */
	requestedPathKey?: string;
	/** Current runtime cwd, which can change when a session is replaced. */
	cwd: string;
	/** Live attachments (open + later attaches). The runtime is disposed only when the last one closes. */
	attachments: number;
	/**
	 * Opt-in retention: a dropped connection only DETACHES from this session. The
	 * entry stays open at zero attachments (still listed, still running its turn,
	 * still holding its path) until an explicit close_session or idle eviction.
	 * Requested per `open_session`; an attach may turn it on, never off.
	 */
	retainOnDisconnect?: boolean;
	/** Timestamp of the last routed command / observed activity; drives idle eviction. */
	lastCommandAt: number;
	lifecycleMutex: Promise<void>;
	closeCompletion?: Promise<void>;
	closeResolve?: () => void;
	closeStarted?: boolean;
}

export class RpcSessionRegistryError extends Error {
	readonly code:
		| "unknown_session"
		| "session_closing"
		| "session_path_in_use"
		| "session_id_in_use"
		| "session_reservation_limit"
		| "invalid_path"
		| "invalid_session_id"
		| "host_memory_pressure"
		| "open_failed";
	/** Machine-readable context for the wire (`errorData`): who holds a path, when to retry. */
	readonly detail?: Readonly<Record<string, unknown>>;

	constructor(code: RpcSessionRegistryError["code"], reason?: string, detail?: Readonly<Record<string, unknown>>) {
		super(code === "open_failed" && reason ? `${code}: ${reason}` : code);
		this.code = code;
		this.name = "RpcSessionRegistryError";
		if (detail) this.detail = detail;
	}
}

export interface RpcSessionRegistryOptions {
	agentDir: string;
	createRuntime: CreateAgentSessionRuntimeFactory;
	mcpRegistry?: HostMcpRegistry;
	/** Injectable clock (defaults to Date.now) so idle bookkeeping is testable. */
	now?: () => number;
	/** Maximum time to wait for graceful runtime teardown before forced release. */
	closeGraceMs?: number;
	/**
	 * Cross-GENERATION path claims. During a handoff two hosts are alive at once, and only a
	 * claim outside either process can keep them off one JSONL. Absent for an embedded registry
	 * that is the only host of its agent directory.
	 */
	pathReservations?: SessionPathReservations;
}

/**
 * Why the host currently declines to CREATE a worker session: it is above its RSS refuse
 * watermark. Carried verbatim to the client as `errorData` so it knows when to retry.
 */
export interface WorkerAdmissionRefusal {
	readonly rssMb: number;
	readonly retry_after_ms: number;
}

/** Host-side lifecycle policy for one `open_session`, distinct from the session's launch profile. */
export interface RpcSessionOpenOptions {
	/** Keep the session alive when its last client disconnects (`open_session.retain_on_disconnect`). */
	retainOnDisconnect?: boolean;
}

/** One `list_sessions` row. `context` is published only to a listing that asked for workers. */
export interface RpcSessionRow {
	sessionId: string;
	durableSessionId?: string;
	sessionPath?: string;
	cwd: string;
	name?: string;
	status: Exclude<RpcSessionState, "quarantined">;
	attachments: number;
	kind: SessionKind;
	context: SessionContext;
}

export interface OpenRpcSession {
	sessionId: string;
	durableSessionId: string;
	sessionPath?: string;
	/** True when this open attached to an already-open session instead of creating one. */
	attached?: boolean;
}

/** Freezes an open's launch inputs, including the nested objects a client supplied. */
export function frozenProfile(profile: RpcSessionLaunchProfile): Readonly<RpcSessionLaunchProfile> {
	return Object.freeze({
		...profile,
		...(profile.creationModel ? { creationModel: Object.freeze({ ...profile.creationModel }) } : {}),
		...(profile.sessionContext ? { sessionContext: Object.freeze({ ...profile.sessionContext }) } : {}),
	});
}

/**
 * The visibility class and labels an entry keeps for its life, normalized once here so no
 * lifecycle, listing or delivery decision has to re-apply the defaults. Reads the already
 * frozen profile, so the entry and the runtime share one frozen context object.
 */
export function sessionIdentity(profile: Readonly<RpcSessionLaunchProfile>): {
	readonly kind: SessionKind;
	readonly context: SessionContext;
} {
	return { kind: profile.sessionKind ?? "interactive", context: profile.sessionContext ?? EMPTY_SESSION_CONTEXT };
}

/** Process-local lifecycle owner for multi-session RPC runtimes. */
export class RpcSessionRegistry {
	private readonly entries = new Map<string, RpcSessionEntry>();
	private readonly reservations = new Set<string>();
	private readonly teardownHost: SessionTeardownHost;
	private nextHandle = 0;
	private readonly options: RpcSessionRegistryOptions;
	private readonly now: () => number;
	readonly closeGraceMs: number;
	private workerRefusal: WorkerAdmissionRefusal | undefined;

	constructor(options: RpcSessionRegistryOptions) {
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
			delete: (handle) => this.entries.delete(handle),
			releaseReservation: (key) => {
				this.reservations.delete(key);
				this.options.pathReservations?.release(key);
			},
			markDetached: (key) => this.options.pathReservations?.setAttached(key, false),
			sync: () => this.syncRuntimeMetadata(),
		};
	}

	/** Number of live entries, including ones still opening or closing. */
	get size(): number {
		return this.entries.size;
	}

	/**
	 * While set, an open that would CREATE a worker session is refused with
	 * `host_memory_pressure`; attaches to a live path and interactive opens are unaffected.
	 * The only memory-driven refusal on the in-process path - never an occupancy count.
	 */
	setWorkerAdmission(refusal: WorkerAdmissionRefusal | undefined): void {
		this.workerRefusal = refusal;
	}

	async openSession(profile: RpcSessionLaunchProfile, options?: RpcSessionOpenOptions): Promise<OpenRpcSession> {
		this.validateProfile(profile);
		this.syncRuntimeMetadata();
		const sessionPath = profile.sessionPath ? canonicalSessionPath(profile.sessionPath) : undefined;
		// Taken SYNCHRONOUSLY, before any await, exactly like the path reservation below: a
		// concurrent open naming the same durable id must find this one already recorded rather
		// than a window between the decision and the record of it. Two LIVE sessions may never
		// share a durable id - every per-session artifact a client keys by it would collide.
		// Re-opening the SAME file is an attach/resume, not a collision: the id is the file's own.
		const requestedDurableId = profile.durableSessionId;
		if (requestedDurableId !== undefined) {
			for (const entry of this.entries.values()) {
				if (entry.state === "closed") continue;
				if (entry.durableSessionId !== requestedDurableId) continue;
				if (sessionPath !== undefined && entry.reservationKey === sessionPath) continue;
				throw new RpcSessionRegistryError("session_id_in_use");
			}
		}
		if (sessionPath) await this.settleClosingReservation(sessionPath);
		if (sessionPath && this.reservations.has(sessionPath)) {
			// Attach-on-open: a live session outlives individual client attachments, so a
			// resume (or a second surface) for an already-hosted path joins the existing
			// runtime instead of failing. An entry still opening keeps the exclusive
			// reservation and rejects as before.
			const existing = [...this.entries].find(
				([, entry]) => entry.reservationKey === sessionPath && entry.state === "open",
			);
			if (!existing) throw new RpcSessionRegistryError("session_path_in_use");
			const [handle, entry] = existing;
			const wasParked = entry.retainOnDisconnect === true && entry.attachments === 0;
			entry.attachments += 1;
			// The claim carries the attachment state another generation decides on: a path this host is
			// actively serving a client on is never reclaimable from it.
			this.options.pathReservations?.setAttached(sessionPath, true);
			// Retention is a property of the live session: any attach may ask for it, and
			// no attach may revoke it for the clients that already rely on it.
			if (options?.retainOnDisconnect) entry.retainOnDisconnect = true;
			if (!entry.durableSessionId) throw new RpcSessionRegistryError("session_path_in_use");
			entry.lastCommandAt = this.now();
			if (wasParked) {
				entry.lifecycleMutex = entry.lifecycleMutex.then(() =>
					entry.runtime?.emitAttachmentEvent("session_resumed"),
				);
				await entry.lifecycleMutex;
			}
			return {
				sessionId: handle,
				durableSessionId: entry.durableSessionId,
				sessionPath: entry.sessionPath,
				attached: true,
			};
		}
		if (this.workerRefusal && profile.sessionKind === "worker")
			throw new RpcSessionRegistryError("host_memory_pressure", undefined, { ...this.workerRefusal });
		if (sessionPath) {
			// Taken SYNCHRONOUSLY, before any await: a concurrent open for the same path must find the
			// reservation already held, not a window between the decision and the record of it.
			this.reservations.add(sessionPath);
			// Another generation of this daemon may still be writing this file. Its claim is the only
			// thing this process can see across a handoff, and a live one means "retry", not "gone".
			// Only AWAIT when there is a cross-generation claim to take: `await undefined` still costs a
			// microtask, and an embedded registry (no second generation) must reach the "opening" entry
			// in the same tick a caller that raced it would look, exactly as it did before generations.
			const holder = this.options.pathReservations
				? await this.options.pathReservations.claim(sessionPath)
				: undefined;
			if (holder) {
				this.reservations.delete(sessionPath);
				throw new RpcSessionRegistryError("session_path_in_use", undefined, {
					owner: holder,
					retry_after_ms: SESSION_PATH_RETRY_AFTER_MS,
				});
			}
		}

		// Resume vs create parity (D1 + omo SenpiSessionRuntime.ts:198-200):
		// Create-only launch semantics mirror classic startup flags. A resumed
		// session restores its persisted model and thinking level instead of being
		// overridden by the new open_session request.
		const isResume = sessionPath !== undefined && existsSync(sessionPath);
		// Re-opening an existing session file is a resume, exactly like interactive
		// /resume (AgentSessionRuntime.switchSession). Without the event the session
		// starts with reason "startup" and every extension that only rebuilds state
		// on a resume - the ask-user dangling-question hook - stays unreachable from
		// the RPC restart path. A session created by this open stays "startup".
		const sessionStartEvent: SessionStartEvent | undefined = isResume
			? { type: "session_start", reason: "resume" }
			: undefined;
		const storedProfile = frozenProfile({ ...profile, ...(sessionPath ? { sessionPath } : {}) });
		const runtimeProfile = isResume
			? frozenProfile({ ...storedProfile, creationModel: undefined, initialThinkingLevel: undefined })
			: storedProfile;

		const handle = `rpc-${++this.nextHandle}`;
		const entry: RpcSessionEntry = {
			state: "opening",
			scope: new ProviderScope(),
			profile: storedProfile,
			...sessionIdentity(storedProfile),
			sessionPath,
			reservationKey: sessionPath,
			cwd: storedProfile.cwd,
			attachments: 1,
			retainOnDisconnect: options?.retainOnDisconnect === true,
			lastCommandAt: this.now(),
			lifecycleMutex: Promise.resolve(),
		};
		entry.switchSession = (sessionPath, options) => {
			const operation = entry.lifecycleMutex.then(async () => {
				if (entry.state !== "open" || !entry.runtime) {
					throw new RpcSessionRegistryError("unknown_session");
				}
				const runtime = entry.runtime;
				const cwdOverride = options?.cwdOverride;
				const cwdChanged = cwdOverride !== undefined && runtime.session.sessionManager.getCwd() !== cwdOverride;
				const result = await runtime.switchSession(sessionPath, options);
				if (result.cancelled || !cwdChanged) return result;

				// A multi-session binding outlives an individual replacement. Keep the
				// entry's runtime object aligned with the replacement so every attached
				// client resolves getters and future commands against the new cwd-bound
				// runtime, not the object created during open_session.
				const replacement = new AgentSessionRuntime(
					runtime.session,
					runtime.services,
					this.options.createRuntime,
					[...runtime.diagnostics],
					runtime.modelFallbackMessage,
					runtime.launchProfile,
				);
				replacement.setRebindSession(entry.rebindSession);
				runtime.releaseSessionHold();
				entry.runtime = replacement;
				this.syncRuntimeMetadata();
				return result;
			});
			entry.lifecycleMutex = operation.then(
				() => undefined,
				() => undefined,
			);
			return operation;
		};
		// Recorded before the first await so the synchronous collision guard above sees an open
		// that is still being built. `manager.getSessionId()` overwrites it below with the
		// authoritative value, which on a resume is the header's id, not the requested one.
		if (requestedDurableId !== undefined) entry.durableSessionId = requestedDurableId;
		this.entries.set(handle, entry);
		try {
			const newSessionOptions = requestedDurableId !== undefined ? { id: requestedDurableId } : undefined;
			const manager = sessionPath
				? SessionManager.open(sessionPath, undefined, storedProfile.cwd, newSessionOptions)
				: SessionManager.create(storedProfile.cwd, undefined, newSessionOptions);
			entry.runtime = await runWithProviderScope(entry.scope, () =>
				createAgentSessionRuntime(this.options.createRuntime, {
					cwd: manager.getCwd(),
					agentDir: this.options.agentDir,
					sessionManager: manager,
					sessionStartEvent,
					launchProfile: runtimeProfile,
				}),
			);
			entry.durableSessionId = manager.getSessionId();
			entry.sessionPath ??= manager.getSessionFile();
			entry.state = "open";
			return { sessionId: handle, durableSessionId: entry.durableSessionId, sessionPath: entry.sessionPath };
		} catch (error) {
			// Runtime construction may have started extensions, watchers, and provider
			// registrations before it rejects. Keep the reservation and entry private
			// until all of those resources have been torn down, then release them as
			// one rollback so the path can immediately be opened again.
			try {
				await entry.runtime?.dispose();
			} catch {
				// The original construction error remains the externally visible cause.
			} finally {
				try {
					await entry.scope.close?.();
				} finally {
					this.entries.delete(handle);
					if (sessionPath) {
						this.reservations.delete(sessionPath);
						this.options.pathReservations?.release(sessionPath);
					}
				}
			}
			if (error instanceof RpcSessionRegistryError) throw error;
			throw new RpcSessionRegistryError("open_failed", error instanceof Error ? error.message : undefined);
		}
	}

	/**
	 * Waits out a teardown already in flight for this path before the open decides.
	 *
	 * A close FREES the path, but the entry keeps its reservation until its runtime is
	 * disposed, so an open landing inside that window used to be refused with
	 * `session_path_in_use` for a session that no longer exists - making "reopen the
	 * path I just closed" a race against disposal latency, which no client can time.
	 * The open now waits for the teardown it would have been refused by and then opens
	 * the file fresh. Bounded by the same grace window that bounds the teardown itself
	 * (`closeMarkedSession` force-releases at that deadline), so a wedged disposal
	 * still ends in the ordinary refusal instead of an open that never answers.
	 */
	private async settleClosingReservation(sessionPath: string): Promise<void> {
		const closing = [...this.entries.values()].find(
			(entry) => entry.reservationKey === sessionPath && entry.state === "closing",
		);
		if (!closing?.closeCompletion) return;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				closing.closeCompletion,
				new Promise<void>((resolve) => {
					deadline = setTimeout(resolve, this.closeGraceMs);
				}),
			]);
		} finally {
			if (deadline) clearTimeout(deadline);
		}
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

	getForCommand(handle: string, command: string): RpcSessionEntry {
		const entry = this.entries.get(handle);
		if (!entry) throw new RpcSessionRegistryError("unknown_session");
		if (
			entry.state === "closing" &&
			!["abort", "abort_bash", "extension_ui_response", "extension_ui_progress"].includes(command)
		) {
			throw new RpcSessionRegistryError("session_closing");
		}
		if (entry.state !== "open" && entry.state !== "closing") throw new RpcSessionRegistryError("unknown_session");
		// Every routed command counts as activity for idle eviction. Lookups that
		// must not refresh idleness (sweeps, listing) use peek()/list() instead.
		entry.lastCommandAt = this.now();
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
		return [...this.entries].map(([sessionId, entry]) => ({
			sessionId,
			durableSessionId: entry.durableSessionId,
			sessionPath: entry.sessionPath,
			cwd: entry.cwd,
			name: entry.runtime?.session.sessionManager.getSessionName(),
			kind: entry.kind,
			context: entry.context,
			// A closing entry has already released its last attachment; never publish that as negative.
			attachments: Math.max(0, entry.attachments),
			status: entry.state === "quarantined" ? "closing" : entry.state,
		}));
	}

	/** Reconcile path and durable identity after runtime replacement. */
	private syncRuntimeMetadata(): void {
		for (const entry of this.entries.values()) {
			const manager = entry.runtime?.session.sessionManager;
			if (!manager) continue;
			const currentPath = manager.getSessionFile();
			const currentKey = currentPath ? canonicalSessionPath(currentPath) : undefined;
			// Preserve the originally canonicalized key while the runtime still points at
			// the same path. SessionManager may expose a symlink-resolved spelling after
			// opening a file that did not exist yet; treating that as replacement would
			// break ordinary attach-on-open aliases.
			//
			// A moved path is not the only reason to reconcile: a session opened WITHOUT
			// `sessionPath` lands its created file straight into `sessionPath` and never
			// takes a reservation, so comparing paths alone leaves that file unclaimed
			// forever and a later open of it builds a SECOND runtime over the same
			// transcript. Reconcile whenever the canonical key we hold is not the key the
			// runtime is actually writing.
			if (currentPath !== entry.sessionPath || currentKey !== entry.reservationKey) {
				if (entry.reservationKey) {
					this.reservations.delete(entry.reservationKey);
					this.options.pathReservations?.release(entry.reservationKey);
				}
				if (currentKey) {
					this.reservations.add(currentKey);
					// A replacement moved this session to another file; the claim follows it, carrying the
					// attachment state it is now held at. A file a live foreign generation holds is left
					// alone by claim() itself.
					void this.options.pathReservations?.claim(currentKey, entry.attachments > 0);
				}
				entry.reservationKey = currentKey;
				entry.sessionPath = currentPath;
			}
			entry.durableSessionId = manager.getSessionId();
			entry.cwd = manager.getCwd();
		}
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
