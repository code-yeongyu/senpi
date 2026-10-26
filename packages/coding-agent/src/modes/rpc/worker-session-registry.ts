import type { CliRuntimeConfiguration } from "../../main.ts";
import type { SessionPathReservations as DaemonPathReservations } from "./host-reservations.ts";
import { refreshesSessionActivity } from "./session-command-activity.ts";
import { publishedSessionContext } from "./session-context-patch.ts";
import { attachLiveSession } from "./session-live-attachment.ts";
import { type LiveWorkerPaths, SessionPathReservations } from "./session-path-reservations.ts";
import {
	frozenProfile,
	type OpenRpcSession,
	type RpcSessionEntry,
	type RpcSessionLaunchProfile,
	type RpcSessionOpenOptions,
	RpcSessionRegistryError,
	type RpcSessionRow,
} from "./session-registry.ts";
import { SessionWorkerClient } from "./session-worker-client.ts";
import type { SessionWriteGrant } from "./session-worker-protocol.ts";
import type { WorkerSessionClaims } from "./worker-session-claims.ts";
import { openWorkerSession } from "./worker-session-open.ts";

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

	openSession(profile: RpcSessionLaunchProfile, options?: RpcSessionOpenOptions): Promise<OpenRpcSession> {
		return openWorkerSession(
			{
				entries: this.entries,
				reservations: this.reservations,
				claims: this.claims,
				options: this.options,
				closeGraceMs: this.closeGraceMs,
				size: this.size,
				now: this.now,
				nextHandle: () => `rpc-${++this.serial}`,
				knownReservationKey: (path) => this.knownReservationKey(path),
				attach: (owner, path, options, requested) => this.attach(owner, path, options, requested),
				reserve: (handle, path) => this.reserve(handle, path),
				reconcile: (handle, paths) => this.reconcile(handle, paths),
				openResult: (handle, entry) => this.openResult(handle, entry),
				createWorker: this.createWorker,
			},
			profile,
			options,
		);
	}

	peek(handle: string): RpcSessionEntry | undefined {
		return this.entries.get(handle);
	}

	attachSession(handle: string): RpcSessionEntry {
		return attachLiveSession(this.entries.get(handle), this.now(), () => this.claims.get(handle)?.setAttached(true));
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
		const now = this.now();
		return [...this.entries].map(([sessionId, entry]) => {
			const state = entry.worker?.snapshot?.state;
			return {
				sessionId,
				durableSessionId: state?.sessionId ?? entry.durableSessionId,
				sessionPath: state?.sessionFile ?? entry.sessionPath,
				cwd: state?.cwd ?? entry.cwd,
				name: state?.sessionName,
				kind: entry.kind,
				context: publishedSessionContext(entry.context, entry.contextOverlay),
				// A closing entry has already released its last attachment; never publish that as negative.
				attachments: Math.max(0, entry.attachments),
				status: entry.state === "quarantined" ? "closing" : entry.state,
				idleMs: Math.max(0, now - entry.lastCommandAt),
				// A worker isolate's session has no tool child of its own yet (senpi#3566 todo 4 serves the in-process host).
				tool_child: { state: "none" },
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
