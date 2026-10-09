import { isAbsolute } from "node:path";
import { ProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { assertValidSessionId } from "../../core/session-manager.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import {
	type SessionPathReservations as DaemonPathReservations,
	SESSION_PATH_RETRY_AFTER_MS,
} from "./host-reservations.ts";
import { refreshesSessionActivity } from "./session-command-activity.ts";
import {
	type LiveWorkerPaths,
	RESERVATION_DENIAL_CODES,
	SessionPathReservations,
} from "./session-path-reservations.ts";
import {
	frozenProfile,
	type OpenRpcSession,
	type RpcSessionEntry,
	type RpcSessionLaunchProfile,
	type RpcSessionOpenOptions,
	RpcSessionRegistryError,
	type RpcSessionRow,
	sessionIdentity,
} from "./session-registry.ts";
import { releaseWithinGrace } from "./session-teardown.ts";
import { SessionWorkerClient } from "./session-worker-client.ts";
import { SESSION_WORKER_LIMITS, type SessionWriteGrant, typedWorkerRefusal } from "./session-worker-protocol.ts";
import { WorkerSessionClaims } from "./worker-session-claims.ts";

type SessionWorkerCallbacks = ConstructorParameters<typeof SessionWorkerClient>[0];

export interface WorkerSessionRegistryOptions {
	readonly configuration: CliRuntimeConfiguration;
	readonly closeGraceMs: number;
	readonly now: () => number;
	/** Production builds the real worker; a caller may supply one to drive a lifecycle path deterministically. */
	readonly createWorker?: (callbacks: SessionWorkerCallbacks) => SessionWorkerClient;
	readonly pathReservations?: DaemonPathReservations;
}

/** Transport-side lifecycle owner. Caller paths are never inspected on this event loop. */
export class WorkerSessionRegistry {
	private readonly entries = new Map<string, RpcSessionEntry>();
	private readonly reservations = new SessionPathReservations();
	private readonly claims = new Map<string, WorkerSessionClaims>();
	private serial = 0;
	readonly closeGraceMs: number;
	private readonly now: () => number;

	private readonly options: WorkerSessionRegistryOptions;
	private readonly createWorker: (callbacks: SessionWorkerCallbacks) => SessionWorkerClient;

	constructor(options: WorkerSessionRegistryOptions) {
		this.options = options;
		this.closeGraceMs = options.closeGraceMs;
		this.now = options.now;
		this.createWorker = options.createWorker ?? ((callbacks) => new SessionWorkerClient(callbacks));
	}

	get size(): number {
		return this.entries.size;
	}

	holderPids(observedStarts?: ReadonlyMap<number, number | undefined>): Promise<readonly number[]> {
		return this.options.pathReservations?.holderPids?.(observedStarts) ?? Promise.resolve([]);
	}

	async openSession(profile: RpcSessionLaunchProfile, options?: RpcSessionOpenOptions): Promise<OpenRpcSession> {
		if (!isAbsolute(profile.cwd) || (profile.sessionPath !== undefined && !isAbsolute(profile.sessionPath)))
			throw new RpcSessionRegistryError("invalid_path");
		// Same contract as RpcSessionRegistry.openSession (#1951), on the registry the multi-session
		// host actually instantiates (#2010). Both checks run SYNCHRONOUSLY before the first await:
		// the format check so a bad id is refused with its own code instead of surfacing as the
		// worker's death (`session_closing`), and the collision scan so a concurrent open naming the
		// same durable id finds this one already recorded. Re-opening the SAME path is an attach,
		// not a collision: the id is the file's own.
		const requestedDurableId = profile.durableSessionId;
		if (requestedDurableId !== undefined) {
			try {
				assertValidSessionId(requestedDurableId);
			} catch (cause) {
				throw new RpcSessionRegistryError("invalid_session_id", String(cause));
			}
			const requestedKey = profile.sessionPath ? this.knownReservationKey(profile.sessionPath) : undefined;
			for (const entry of this.entries.values()) {
				if (entry.state === "closed") continue;
				if (entry.durableSessionId !== requestedDurableId) continue;
				if (requestedKey !== undefined && entry.reservationKey === requestedKey) continue;
				throw new RpcSessionRegistryError("session_id_in_use");
			}
		}
		if (profile.sessionPath) {
			const key = this.knownReservationKey(profile.sessionPath);
			const owner = key ? this.reservations.owner(key) : undefined;
			if (key && owner) return this.attach(owner, key, options, profile);
		}
		if (this.size >= SESSION_WORKER_LIMITS.workers) throw new Error("too_many_sessions");
		const handle = `rpc-${++this.serial}`;
		const claims = new WorkerSessionClaims(this.options.pathReservations);
		this.claims.set(handle, claims);
		const storedProfile = frozenProfile(profile);
		const entry: RpcSessionEntry = {
			state: "opening",
			scope: new ProviderScope(),
			profile: storedProfile,
			...sessionIdentity(storedProfile),
			cwd: profile.cwd,
			attachments: 1,
			retainOnDisconnect: options?.retainOnDisconnect === true,
			lastCommandAt: this.now(),
			lifecycleMutex: Promise.resolve(),
			// Recorded before the first await so the collision scan above sees an open still being
			// built; `snapshot.state.sessionId` overwrites it with the authoritative value after
			// commit, which on a resume is the header's id rather than the requested one.
			...(requestedDurableId !== undefined ? { durableSessionId: requestedDurableId } : {}),
		};
		let workerFailure: string | undefined;
		const worker = this.createWorker({
			reserve: (path) => this.reserve(handle, path),
			reconcile: (livePaths) => this.reconcile(handle, livePaths),
			exit: () => {
				if (this.entries.get(handle) !== entry) return;
				const finish = (): void => {
					if (this.entries.get(handle) !== entry) return;
					entry.state = "closed";
					this.entries.delete(handle);
					this.claims.delete(handle);
					this.reservations.releaseAll(handle);
					entry.closeResolve?.();
				};
				return releaseWithinGrace(
					{ closeGraceMs: this.closeGraceMs, releaseReservation: () => claims.close() },
					handle,
					entry.reservationKey ?? handle,
				).then(finish);
			},
			failure: (error) => {
				// The open below only learns that its entry left `opening`, never why. Without this the
				// caller is told `session_closing` - a path whose owner is tearing down - for a worker
				// that died, and the actual reason reaches stderr alone (#1953).
				workerFailure = error;
				entry.state = "quarantined";
				process.stderr.write(`senpi rpc session ${handle} quarantined: ${error}\n`);
			},
		});
		entry.worker = worker;
		this.entries.set(handle, entry);
		try {
			const path = await worker.prepare(this.options.configuration, profile).catch(typedWorkerRefusal);
			const owner = this.reservations.owner(path);
			if (owner) {
				const attached = await this.attach(owner, path, options, profile);
				entry.state = "quarantined";
				worker.quarantine();
				return attached;
			}
			const predecessor = await claims.claim(path);
			if (predecessor)
				throw new RpcSessionRegistryError("session_path_in_use", undefined, {
					owner: predecessor,
					retry_after_ms: SESSION_PATH_RETRY_AFTER_MS,
				});
			const grant = await this.reserve(handle, path);
			if (grant !== "granted") throw new RpcSessionRegistryError(RESERVATION_DENIAL_CODES[grant]);
			entry.reservationKey = path;
			entry.requestedPathKey = profile.sessionPath ? path : undefined;
			entry.sessionPath = path;
			const snapshot = await worker.commit();
			if (entry.state !== "opening")
				throw workerFailure === undefined
					? new RpcSessionRegistryError("session_closing")
					: new RpcSessionRegistryError("open_failed", workerFailure.replace(/^open_failed: /, ""));
			entry.durableSessionId = snapshot.state.sessionId;
			entry.cwd = snapshot.state.cwd;
			entry.state = "open";
			return this.openResult(handle, entry);
		} catch (cause) {
			entry.state = "quarantined";
			worker.quarantine();
			throw cause;
		}
	}

	peek(handle: string): RpcSessionEntry | undefined {
		return this.entries.get(handle);
	}

	getForCommand(handle: string, command: string): RpcSessionEntry {
		const entry = this.entries.get(handle);
		if (!entry) throw new RpcSessionRegistryError("unknown_session");
		if (
			entry.state === "quarantined" ||
			(entry.state === "closing" &&
				!["abort", "abort_bash", "extension_ui_response", "extension_ui_progress"].includes(command))
		)
			throw new RpcSessionRegistryError("session_closing");
		if (entry.state !== "open" && entry.state !== "closing") throw new RpcSessionRegistryError("unknown_session");
		// Polling a session nobody holds is observation, not work that needs its runtime;
		// an attached client's polling keeps its session alive exactly as before.
		if (entry.attachments > 0 || refreshesSessionActivity(command)) entry.lastCommandAt = this.now();
		return entry;
	}

	beginClose(handle: string, onRole?: (finalizer: boolean) => void, options?: { detach?: boolean }): RpcSessionEntry {
		const entry = this.entries.get(handle);
		if (!entry) throw new RpcSessionRegistryError("unknown_session");
		if (entry.state === "closing" || entry.state === "quarantined") {
			onRole?.(false);
			return entry;
		}
		if (entry.state !== "open" && entry.state !== "opening") throw new RpcSessionRegistryError("unknown_session");
		entry.attachments--;
		if (entry.attachments > 0) return entry;
		// A retained session answers a client's detach by staying open at zero
		// attachments; only an explicit close or eviction reaches the worker.
		if (options?.detach && entry.retainOnDisconnect) {
			entry.attachments = 0;
			entry.detachedAt ??= this.now();
			if (!entry.worker?.busy) this.claims.get(handle)?.setAttached(false);
			return entry;
		}
		entry.state = "closing";
		entry.closeCompletion = new Promise((resolve) => {
			entry.closeResolve = resolve;
		});
		onRole?.(true);
		return entry;
	}

	close(handle: string): Promise<void> {
		const entry = this.beginClose(handle);
		return entry.state === "closing" ? this.closeMarked(handle) : Promise.resolve();
	}

	async closeMarked(handle: string): Promise<void> {
		const entry = this.entries.get(handle);
		if (entry?.state !== "closing" || !entry.worker) throw new RpcSessionRegistryError("unknown_session");
		if (entry.closeStarted) return entry.closeCompletion;
		entry.closeStarted = true;
		// Reply on a bounded deadline, but keep entry, attachments and reservations until exit.
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			entry.worker.close(this.closeGraceMs),
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					if (entry.state !== "closed") entry.state = "quarantined";
					resolve();
				}, this.closeGraceMs);
			}),
		]);
		if (timer) clearTimeout(timer);
	}

	list(): RpcSessionRow[] {
		return [...this.entries].map(([sessionId, entry]) => {
			const state = entry.worker?.snapshot?.state;
			return {
				sessionId,
				durableSessionId: state?.sessionId ?? entry.durableSessionId,
				sessionPath: state?.sessionFile ?? entry.sessionPath,
				cwd: state?.cwd ?? entry.cwd,
				name: state?.sessionName,
				kind: entry.kind,
				context: entry.context,
				// A closing entry has already released its last attachment; never publish that as negative.
				attachments: Math.max(0, entry.attachments),
				status: entry.state === "quarantined" ? "closing" : entry.state,
			};
		});
	}

	/** Only compare spellings already tied to a granted identity; do not inspect caller paths here. */
	private knownReservationKey(path: string): string | undefined {
		if (this.reservations.owner(path)) return path;
		for (const entry of this.entries.values()) {
			// An opening spelling maps only while the key granted for it is still held: a
			// superseded path belongs to nobody and must open its own worker.
			if (
				entry.profile.sessionPath === path &&
				entry.requestedPathKey &&
				this.reservations.owner(entry.requestedPathKey)
			)
				return entry.requestedPathKey;
			const snapshot = entry.worker?.snapshot;
			if (snapshot?.state.sessionFile === path) return snapshot.sessionPath;
		}
		return undefined;
	}

	private async attach(
		owner: string,
		path: string,
		options?: RpcSessionOpenOptions,
		requested: RpcSessionLaunchProfile = { cwd: "" },
	): Promise<OpenRpcSession> {
		const { promptSurface, browserEngine, permissionPreset } = requested;
		const entry = this.entries.get(owner);
		if (entry?.state !== "open" || !entry.worker?.bindingReady || entry.worker.snapshot?.sessionPath !== path)
			throw new RpcSessionRegistryError("session_path_in_use");
		// Same rule as RpcSessionRegistry: an attach that names a surface moves the live session to it.
		if (promptSurface !== undefined && promptSurface !== entry.profile.promptSurface) {
			entry.profile = frozenProfile({ ...entry.profile, promptSurface });
			await entry.worker.setPromptSurface(promptSurface);
		}
		if (browserEngine !== undefined && browserEngine !== entry.profile.browserEngine) {
			entry.profile = frozenProfile({ ...entry.profile, browserEngine });
			await entry.worker.setBrowserEngine(browserEngine);
		}
		// Sent even when the record already names it: only the worker sees its live session (senpi#2842).
		if (permissionPreset !== undefined) {
			entry.profile = frozenProfile({ ...entry.profile, permissionPreset });
			await entry.worker.setPermissionPreset(permissionPreset);
		}
		const result = this.openResult(owner, entry);
		entry.attachments++;
		this.claims.get(owner)?.setAttached(true);
		// Retention is a property of the live session: any attach may ask for it, and
		// no attach may revoke it for the clients that already rely on it.
		if (options?.retainOnDisconnect) entry.retainOnDisconnect = true;
		entry.lastCommandAt = this.now();
		return { ...result, attached: true };
	}

	/** Granted paths currently held by a handle; the per-worker budget is bounded by it. */
	reservationCount(handle: string): number {
		return this.reservations.count(handle);
	}

	private async reserve(handle: string, path: string): Promise<SessionWriteGrant> {
		const entry = this.entries.get(handle);
		if (!entry) return "conflict";
		if (this.reservations.owner(path) === handle) return "granted";
		if (entry.state !== "opening" && entry.state !== "open") return "conflict";
		const grant = this.reservations.reserve(handle, path, this.liveWorkerPaths(entry));
		if (grant !== "granted") return grant;
		const owner = await this.claims.get(handle)?.claim(path, entry.attachments > 0 || entry.worker?.busy === true);
		if (owner || this.entries.get(handle) !== entry || (entry.state !== "opening" && entry.state !== "open")) {
			const live = this.liveWorkerPaths(entry);
			this.reservations.reconcile(handle, live ?? { livePaths: [], sessionPath: entry.reservationKey });
			return "conflict";
		}
		return "granted";
	}

	/**
	 * Releases the grants a worker's latest snapshot no longer claims.
	 *
	 * Only a fully open entry reports live writers. An entry still opening, closing or
	 * quarantined keeps every grant until its real exit, because a worker stuck in a
	 * syscall can still be writing a path it can no longer report.
	 */
	private async reconcile(handle: string, livePaths: readonly string[]): Promise<void> {
		const entry = this.entries.get(handle);
		if (entry?.state !== "open") return;
		const sessionPath = entry.worker?.snapshot?.sessionPath;
		const attached = entry.attachments > 0 || entry.worker?.busy === true;
		if (sessionPath) {
			const owner = await this.claims.get(handle)?.claim(sessionPath, attached);
			if (owner) throw new RpcSessionRegistryError("session_path_in_use");
			if (this.entries.get(handle) !== entry || entry.state !== "open") return;
		}
		this.reservations.reconcile(handle, { livePaths, sessionPath });
		this.claims.get(handle)?.reconcile(sessionPath ? [...livePaths, sessionPath] : livePaths, attached);
		if (!sessionPath) return;
		entry.reservationKey = sessionPath;
		entry.sessionPath = sessionPath;
	}

	/** The live view a full budget is reconciled against; absent while the entry cannot report one. */
	private liveWorkerPaths(entry: RpcSessionEntry): LiveWorkerPaths | undefined {
		const snapshot = entry.state === "open" ? entry.worker?.snapshot : undefined;
		if (!snapshot) return undefined;
		return { livePaths: snapshot.liveSessionPaths, sessionPath: snapshot.sessionPath };
	}

	private openResult(handle: string, entry: RpcSessionEntry): OpenRpcSession {
		const state = entry.worker?.snapshot?.state;
		if (!state) throw new RpcSessionRegistryError("open_failed");
		return { sessionId: handle, durableSessionId: state.sessionId, sessionPath: state.sessionFile };
	}
}
