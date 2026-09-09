import { isAbsolute } from "node:path";
import { ProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import type { CliRuntimeConfiguration } from "../../main.ts";
import {
	type OpenRpcSession,
	type RpcSessionEntry,
	type RpcSessionLaunchProfile,
	RpcSessionRegistryError,
} from "./session-registry.ts";
import { SessionWorkerClient } from "./session-worker-client.ts";
import { SESSION_WORKER_LIMITS } from "./session-worker-protocol.ts";

/** Transport-side lifecycle owner. Caller paths are never inspected on this event loop. */
export class WorkerSessionRegistry {
	private readonly entries = new Map<string, RpcSessionEntry>();
	private readonly reservations = new Map<string, string>();
	private serial = 0;
	readonly closeGraceMs: number;
	private readonly now: () => number;

	private readonly options: { configuration: CliRuntimeConfiguration; closeGraceMs: number; now: () => number };

	constructor(options: { configuration: CliRuntimeConfiguration; closeGraceMs: number; now: () => number }) {
		this.options = options;
		this.closeGraceMs = options.closeGraceMs;
		this.now = options.now;
	}

	get size(): number {
		return this.entries.size;
	}

	async openSession(profile: RpcSessionLaunchProfile): Promise<OpenRpcSession> {
		if (!isAbsolute(profile.cwd) || (profile.sessionPath !== undefined && !isAbsolute(profile.sessionPath)))
			throw new RpcSessionRegistryError("invalid_path");
		if (profile.sessionPath) {
			const key = this.knownReservationKey(profile.sessionPath);
			const owner = key ? this.reservations.get(key) : undefined;
			if (key && owner) return this.attach(owner, key);
		}
		if (this.size >= SESSION_WORKER_LIMITS.workers) throw new Error("too_many_sessions");
		const handle = `rpc-${++this.serial}`;
		const entry: RpcSessionEntry = {
			state: "opening",
			scope: new ProviderScope(),
			profile: Object.freeze({ ...profile }),
			cwd: profile.cwd,
			attachments: 1,
			lastCommandAt: this.now(),
			lifecycleMutex: Promise.resolve(),
		};
		const worker = new SessionWorkerClient({
			reserve: (path) => this.reserve(handle, path),
			release: (path) => {
				if (this.reservations.get(path) === handle) this.reservations.delete(path);
			},
			exit: () => {
				if (this.entries.get(handle) !== entry) return;
				entry.state = "closed";
				this.entries.delete(handle);
				for (const [path, owner] of this.reservations) if (owner === handle) this.reservations.delete(path);
				entry.closeResolve?.();
			},
			failure: (error) => {
				entry.state = "quarantined";
				process.stderr.write(`senpi rpc session ${handle} quarantined: ${error}\n`);
			},
		});
		entry.worker = worker;
		this.entries.set(handle, entry);
		try {
			const path = await worker.prepare(this.options.configuration, profile);
			const owner = this.reservations.get(path);
			if (owner) {
				const attached = this.attach(owner, path);
				entry.state = "quarantined";
				worker.quarantine();
				return attached;
			}
			if (!this.reserve(handle, path)) throw new RpcSessionRegistryError("session_path_in_use");
			entry.reservationKey = path;
			entry.sessionPath = path;
			const snapshot = await worker.commit();
			if (entry.state !== "opening") throw new RpcSessionRegistryError("session_closing");
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
			(entry.state === "closing" && !["abort", "abort_bash", "extension_ui_response"].includes(command))
		)
			throw new RpcSessionRegistryError("session_closing");
		if (entry.state !== "open" && entry.state !== "closing") throw new RpcSessionRegistryError("unknown_session");
		entry.lastCommandAt = this.now();
		return entry;
	}

	beginClose(handle: string, onRole?: (finalizer: boolean) => void): RpcSessionEntry {
		const entry = this.entries.get(handle);
		if (!entry) throw new RpcSessionRegistryError("unknown_session");
		if (entry.state === "closing" || entry.state === "quarantined") {
			onRole?.(false);
			return entry;
		}
		if (entry.state !== "open" && entry.state !== "opening") throw new RpcSessionRegistryError("unknown_session");
		entry.attachments--;
		if (entry.attachments > 0) return entry;
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

	list(): Array<{
		sessionId: string;
		durableSessionId?: string;
		sessionPath?: string;
		cwd: string;
		name?: string;
		status: Exclude<RpcSessionEntry["state"], "quarantined">;
	}> {
		return [...this.entries].map(([sessionId, entry]) => {
			const state = entry.worker?.snapshot?.state;
			return {
				sessionId,
				durableSessionId: state?.sessionId ?? entry.durableSessionId,
				sessionPath: state?.sessionFile ?? entry.sessionPath,
				cwd: state?.cwd ?? entry.cwd,
				name: state?.sessionName,
				status: entry.state === "quarantined" ? "closing" : entry.state,
			};
		});
	}

	/** Only compare spellings already tied to a granted identity; do not inspect caller paths here. */
	private knownReservationKey(path: string): string | undefined {
		if (this.reservations.has(path)) return path;
		for (const entry of this.entries.values()) {
			if (entry.profile.sessionPath === path && entry.reservationKey) return entry.reservationKey;
			const snapshot = entry.worker?.snapshot;
			if (snapshot?.state.sessionFile === path) return snapshot.sessionPath;
		}
		return undefined;
	}

	private attach(owner: string, path: string): OpenRpcSession {
		const entry = this.entries.get(owner);
		if (entry?.state !== "open" || !entry.worker?.bindingReady || entry.worker.snapshot?.sessionPath !== path)
			throw new RpcSessionRegistryError("session_path_in_use");
		const result = this.openResult(owner, entry);
		entry.attachments++;
		entry.lastCommandAt = this.now();
		return { ...result, attached: true };
	}

	private reserve(handle: string, path: string): boolean | "acquired" {
		const entry = this.entries.get(handle);
		if (!entry) return false;
		const owner = this.reservations.get(path);
		if (owner) return owner === handle;
		if (entry.state !== "opening" && entry.state !== "open") return false;
		let count = 0;
		for (const current of this.reservations.values()) if (current === handle) count++;
		if (count >= SESSION_WORKER_LIMITS.reservations) return false;
		this.reservations.set(path, handle);
		return "acquired";
	}

	private openResult(handle: string, entry: RpcSessionEntry): OpenRpcSession {
		const state = entry.worker?.snapshot?.state;
		if (!state) throw new RpcSessionRegistryError("open_failed");
		return { sessionId: handle, durableSessionId: state.sessionId, sessionPath: state.sessionFile };
	}
}
