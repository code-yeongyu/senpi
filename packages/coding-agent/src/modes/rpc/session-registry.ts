import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import {
	type AgentSessionLaunchProfile,
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { beginSessionClose, closeMarkedSession, closeSession, type SessionTeardownHost } from "./session-teardown.ts";

/** The immutable flags selected when a routing session is opened. */
export interface RpcSessionLaunchProfile extends AgentSessionLaunchProfile {
	sessionPath?: string;
}

export type SessionRuntime = AgentSessionRuntime;
export type RpcSessionState = "opening" | "open" | "closing" | "closed";

export interface RpcSessionEntry {
	state: RpcSessionState;
	runtime?: SessionRuntime;
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
	/** Current runtime cwd, which can change when a session is replaced. */
	cwd: string;
	/** Live attachments (open + later attaches). The runtime is disposed only when the last one closes. */
	attachments: number;
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
		| "invalid_path"
		| "open_failed"
		| "too_many_sessions";

	constructor(code: RpcSessionRegistryError["code"], reason?: string) {
		super(code === "open_failed" && reason ? `${code}: ${reason}` : code);
		this.code = code;
		this.name = "RpcSessionRegistryError";
	}
}

export interface RpcSessionRegistryOptions {
	agentDir: string;
	createRuntime: CreateAgentSessionRuntimeFactory;
	/** Injectable clock (defaults to Date.now) so idle bookkeeping is testable. */
	now?: () => number;
	/** Cap on concurrently opening/open sessions; attach-on-open is exempt. */
	maxSessions?: number;
	/** Maximum time to wait for graceful runtime teardown before forced release. */
	closeGraceMs?: number;
}

export interface OpenRpcSession {
	sessionId: string;
	durableSessionId: string;
	sessionPath?: string;
	/** True when this open attached to an already-open session instead of creating one. */
	attached?: boolean;
}

function canonicalPath(path: string): string {
	const absolutePath = resolve(path);
	if (existsSync(absolutePath)) return realpathSync(absolutePath);
	return `${realpathSync(dirname(absolutePath))}/${basename(absolutePath)}`;
}

function frozenProfile(profile: RpcSessionLaunchProfile): Readonly<RpcSessionLaunchProfile> {
	return Object.freeze({
		...profile,
		...(profile.creationModel ? { creationModel: Object.freeze({ ...profile.creationModel }) } : {}),
	});
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

	constructor(options: RpcSessionRegistryOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.closeGraceMs = options.closeGraceMs ?? 10_000;
		this.teardownHost = {
			closeGraceMs: this.closeGraceMs,
			get: (handle) => this.entries.get(handle),
			delete: (handle) => this.entries.delete(handle),
			releaseReservation: (key) => this.reservations.delete(key),
			sync: () => this.syncRuntimeMetadata(),
		};
	}

	/** Number of live entries, including ones still opening or closing. */
	get size(): number {
		return this.entries.size;
	}

	async openSession(profile: RpcSessionLaunchProfile): Promise<OpenRpcSession> {
		this.validateProfile(profile);
		this.syncRuntimeMetadata();
		const sessionPath = profile.sessionPath ? canonicalPath(profile.sessionPath) : undefined;
		if (sessionPath && this.reservations.has(sessionPath)) {
			// Attach-on-open: a live session outlives individual client attachments, so a
			// resume (or a second surface) for an already-hosted path joins the existing
			// runtime instead of failing. Entries still opening or closing keep the
			// exclusive reservation and reject as before.
			const existing = [...this.entries].find(
				([, entry]) => entry.reservationKey === sessionPath && entry.state === "open",
			);
			if (!existing) throw new RpcSessionRegistryError("session_path_in_use");
			const [handle, entry] = existing;
			entry.attachments += 1;
			if (!entry.durableSessionId) throw new RpcSessionRegistryError("session_path_in_use");
			entry.lastCommandAt = this.now();
			return {
				sessionId: handle,
				durableSessionId: entry.durableSessionId,
				sessionPath: entry.sessionPath,
				attached: true,
			};
		}
		const maxSessions = this.options.maxSessions;
		if (maxSessions !== undefined && this.countActiveSessions() >= maxSessions) {
			// Reconnect-churn backstop: every open_session owns a complete runtime
			// (hundreds of MB measured), so admission is bounded. Attachments to a
			// live session add none and stay allowed via the branch above.
			throw new RpcSessionRegistryError("too_many_sessions");
		}
		if (sessionPath) this.reservations.add(sessionPath);

		// Resume vs create parity (D1 + omo SenpiSessionRuntime.ts:198-200):
		// Create-only launch semantics mirror classic startup flags. A resumed
		// session restores its persisted model and thinking level instead of being
		// overridden by the new open_session request.
		const isResume = sessionPath !== undefined && existsSync(sessionPath);
		const storedProfile = frozenProfile({ ...profile, ...(sessionPath ? { sessionPath } : {}) });
		const runtimeProfile = isResume
			? frozenProfile({ ...storedProfile, creationModel: undefined, initialThinkingLevel: undefined })
			: storedProfile;

		const handle = `rpc-${++this.nextHandle}`;
		const entry: RpcSessionEntry = {
			state: "opening",
			scope: new ProviderScope(),
			profile: storedProfile,
			sessionPath,
			reservationKey: sessionPath,
			cwd: storedProfile.cwd,
			attachments: 1,
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
		this.entries.set(handle, entry);
		try {
			const manager = sessionPath
				? SessionManager.open(sessionPath, undefined, storedProfile.cwd)
				: SessionManager.create(storedProfile.cwd);
			entry.runtime = await runWithProviderScope(entry.scope, () =>
				createAgentSessionRuntime(this.options.createRuntime, {
					cwd: manager.getCwd(),
					agentDir: this.options.agentDir,
					sessionManager: manager,
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
					if (sessionPath) this.reservations.delete(sessionPath);
				}
			}
			if (error instanceof RpcSessionRegistryError) throw error;
			throw new RpcSessionRegistryError("open_failed", error instanceof Error ? error.message : undefined);
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
		if (entry.state === "closing" && !["abort", "abort_bash", "extension_ui_response"].includes(command)) {
			throw new RpcSessionRegistryError("session_closing");
		}
		if (entry.state !== "open" && entry.state !== "closing") throw new RpcSessionRegistryError("unknown_session");
		// Every routed command counts as activity for idle eviction. Lookups that
		// must not refresh idleness (sweeps, listing) use peek()/list() instead.
		entry.lastCommandAt = this.now();
		return entry;
	}

	/** Starts a close synchronously and returns the live entry for routing decisions. */
	beginClose(handle: string, onRole?: (finalizer: boolean) => void): RpcSessionEntry {
		return beginSessionClose(this.teardownHost, handle, onRole);
	}

	async close(handle: string): Promise<void> {
		return closeSession(this.teardownHost, handle);
	}

	/** Completes a close previously made visible by beginClose(). */
	async closeMarked(handle: string): Promise<void> {
		return closeMarkedSession(this.teardownHost, handle);
	}

	list(): Array<{
		sessionId: string;
		durableSessionId?: string;
		sessionPath?: string;
		cwd: string;
		name?: string;
		status: RpcSessionState;
	}> {
		this.syncRuntimeMetadata();
		return [...this.entries].map(([sessionId, entry]) => ({
			sessionId,
			durableSessionId: entry.durableSessionId,
			sessionPath: entry.sessionPath,
			cwd: entry.cwd,
			name: entry.runtime?.session.sessionManager.getSessionName(),
			status: entry.state,
		}));
	}

	/** Reconcile path and durable identity after runtime replacement. */
	private syncRuntimeMetadata(): void {
		for (const entry of this.entries.values()) {
			const manager = entry.runtime?.session.sessionManager;
			if (!manager) continue;
			const currentPath = manager.getSessionFile();
			// Preserve the originally canonicalized key while the runtime still points at
			// the same path. SessionManager may expose a symlink-resolved spelling after
			// opening a file that did not exist yet; treating that as replacement would
			// break ordinary attach-on-open aliases.
			if (currentPath !== entry.sessionPath) {
				const currentKey = currentPath ? canonicalPath(currentPath) : undefined;
				if (entry.reservationKey) this.reservations.delete(entry.reservationKey);
				if (currentKey) this.reservations.add(currentKey);
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
	}

	private countActiveSessions(): number {
		let count = 0;
		for (const entry of this.entries.values()) {
			if (entry.state === "opening" || entry.state === "open") count += 1;
		}
		return count;
	}
}
