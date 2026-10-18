import { isAbsolute } from "node:path";
import { runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { createAgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { assertValidSessionId, SessionManager } from "../../core/session-manager.ts";
import { ClientAdmissions } from "./client-admissions.ts";
import { EffectLedger } from "./effect-ledger.ts";
import { createRegistryWarm, type HostWarm } from "./host-warm.ts";
import { assertRequestedModelResolved } from "./open-session-model.ts";
import { refreshesSessionActivity } from "./session-command-activity.ts";
import { publishedSessionContext } from "./session-context-patch.ts";
import { canonicalSessionPath } from "./session-path-key.ts";
import { attachToOpenSession } from "./session-registry-attach.ts";
import {
	type PendingClaims,
	settleClosingReservation,
	settlePendingClaim,
	syncRuntimeMetadata,
	takeCrossGenerationClaim,
} from "./session-registry-claims.ts";
import { resolveMovedProfile } from "./session-registry-moved-path.ts";
import { buildOpeningEntry, type OpeningEntry } from "./session-registry-opening.ts";
import {
	type OpenRpcSession,
	type RpcSessionEntry,
	type RpcSessionLaunchProfile,
	type RpcSessionOpenOptions,
	RpcSessionRegistryError,
	type RpcSessionRegistryOptions,
	type RpcSessionRow,
} from "./session-registry-types.ts";
import {
	beginSessionClose,
	closeMarkedSession,
	closeSession,
	releaseWithinGrace,
	type SessionTeardownHost,
} from "./session-teardown.ts";

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

	async openSession(requested: RpcSessionLaunchProfile, options?: RpcSessionOpenOptions): Promise<OpenRpcSession> {
		this.validateProfile(requested);
		const profile = resolveMovedProfile(requested);
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
		if (sessionPath) {
			await settleClosingReservation(this.entries.values(), sessionPath, this.closeGraceMs);
			// Re-checked right before the reservation decision, with no await in between: a waiter woken
			// by a FAILED claim must see the next open's claim, not a bare reservation (senpi#3485 review).
			const deadline = Date.now() + this.closeGraceMs;
			while (this.pendingClaims.has(sessionPath))
				await settlePendingClaim(this.pendingClaims, sessionPath, Math.max(0, deadline - Date.now()));
		}
		if (sessionPath && this.reservations.has(sessionPath)) {
			return attachToOpenSession(
				this.entries,
				sessionPath,
				profile,
				options,
				this.options.pathReservations,
				this.now(),
			);
		}
		if (options?.attachOnly)
			throw new RpcSessionRegistryError("session_not_held", undefined, {
				reason: "session_not_held",
				action: "rediscover_holder",
			});
		let claimSettled: (() => void) | undefined;
		if (sessionPath) {
			// Taken SYNCHRONOUSLY, before any await: a concurrent open for the same path must find the
			// reservation already held, not a window between the decision and the record of it.
			this.reservations.add(sessionPath);
			// Another generation of this daemon may still be writing this file. Its claim is the only
			// thing this process can see across a handoff, and a live one means "retry", not "gone".
			// Only AWAIT when there is a cross-generation claim to take: `await undefined` still costs a
			// microtask, and an embedded registry (no second generation) must reach the "opening" entry
			// in the same tick a caller that raced it would look, exactly as it did before generations.
			// A concurrent open of this path waits on `claimSettled` instead of finding a reservation no
			// entry backs (senpi#3485); it is settled once the entry is recorded or the reservation is back.
			if (this.options.pathReservations)
				claimSettled = await takeCrossGenerationClaim(
					this.reservations,
					this.pendingClaims,
					this.options.pathReservations,
					sessionPath,
				);
		}

		const handle = `rpc-${++this.nextHandle}`;
		let opening: OpeningEntry;
		try {
			opening = buildOpeningEntry({
				profile,
				sessionPath,
				requestedDurableId,
				options,
				now: this.now(),
				createRuntime: this.options.createRuntime,
				sync: () => this.syncRuntimeMetadata(),
			});
		} catch (cause) {
			// Give the path back before waking waiters, or they find a reservation no entry backs. A failed
			// claim release is reported, never allowed to strand the waiters or replace the build error.
			try {
				if (sessionPath) {
					this.reservations.delete(sessionPath);
					await this.options.pathReservations?.release(sessionPath);
				}
			} catch (releaseCause) {
				process.stderr.write(
					`senpi rpc open of ${sessionPath} could not release its claim: ${String(releaseCause)}\n`,
				);
			} finally {
				claimSettled?.();
			}
			throw cause;
		}
		const { entry, storedProfile, runtimeProfile, sessionStartEvent, settleOpen } = opening;
		this.entries.set(handle, entry);
		claimSettled?.();
		this.options.onSizeChange?.(this.entries.size);
		try {
			const newSessionOptions = requestedDurableId !== undefined ? { id: requestedDurableId } : undefined;
			const manager = sessionPath
				? this.options.sessionFileLoad === "blocking"
					? SessionManager.open(sessionPath, undefined, storedProfile.cwd, newSessionOptions)
					: await SessionManager.openAsync(
							sessionPath,
							undefined,
							storedProfile.cwd,
							newSessionOptions,
							this.options.createSlicer?.(),
						)
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
			assertRequestedModelResolved(runtimeProfile, entry.runtime.diagnostics);
			ClientAdmissions.sealQueuedOnReplace(entry.runtime);
			EffectLedger.sealOnReplace(entry.runtime);
			entry.durableSessionId = manager.getSessionId();
			entry.sessionPath ??= manager.getSessionFile();
			entry.state = "open";
			settleOpen.resolve();
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
					this.options.onSizeChange?.(this.entries.size);
					if (sessionPath) await releaseWithinGrace(this.teardownHost, handle, sessionPath);
				}
			}
			if (error instanceof RpcSessionRegistryError) {
				settleOpen.reject(error);
				throw error;
			}
			const wrapped = new RpcSessionRegistryError("open_failed", error instanceof Error ? error.message : undefined);
			settleOpen.reject(wrapped);
			throw wrapped;
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
			status: entry.state === "quarantined" ? "closing" : entry.state,
			idleMs: Math.max(0, now - entry.lastCommandAt),
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
