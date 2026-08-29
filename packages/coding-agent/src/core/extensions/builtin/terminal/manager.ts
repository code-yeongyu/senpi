import {
	SessionRegistry,
	SessionRegistryCapacityError,
	type TerminalSession,
	type TerminalSessionOptions,
} from "@earendil-works/pi-pty";
import { type TerminalRuntimeOptions, TerminalRuntimeSession } from "./runtime-session.ts";
import { DEFAULT_MAX_SESSIONS } from "./shared.ts";

export { SessionRegistryCapacityError } from "@earendil-works/pi-pty";

export interface TerminalManagerOptions {
	readonly getExternalSessionCount?: () => number;
	readonly maxSessions?: number;
	readonly scrollback?: number;
}

export interface CreatedTerminalSession {
	readonly id: string;
	readonly runtime: TerminalRuntimeSession;
}

/**
 * Owns the live terminal sessions for one agent session. Delegates id allocation,
 * capacity caps, LRU-exited pruning, and tree-kill teardown to the pi-pty
 * {@link SessionRegistry}, while keeping the richer {@link TerminalRuntimeSession}
 * wrappers (screen model + output buffer) in lock-step.
 */
export class TerminalManager {
	private readonly registry: SessionRegistry<TerminalSession>;
	private readonly runtimes = new Map<string, TerminalRuntimeSession>();
	private readonly getExternalSessionCount: () => number;
	private readonly maxSessions: number;
	private readonly scrollback?: number;
	private acceptingCreates = true;
	private pendingCreates = 0;

	constructor(options: TerminalManagerOptions = {}) {
		this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
		this.registry = new SessionRegistry<TerminalSession>({
			maxSessions: this.maxSessions,
		});
		this.getExternalSessionCount = options.getExternalSessionCount ?? (() => 0);
		this.scrollback = options.scrollback;
	}

	get size(): number {
		return this.runtimes.size;
	}

	get activeSize(): number {
		return this.registry.list().filter((entry) => entry.state !== "exited").length;
	}

	get capacityCount(): number {
		return this.activeSize + this.pendingCreates;
	}

	/** Spawn a new terminal session and register it under an allocated `bash_N` id. */
	async create(command: string, options: TerminalSessionOptions): Promise<CreatedTerminalSession> {
		if (!this.acceptingCreates) throw new Error("Terminal manager is shutting down.");
		if (this.capacityCount + this.getExternalSessionCount() >= this.maxSessions) {
			throw new SessionRegistryCapacityError(this.maxSessions);
		}
		this.pendingCreates += 1;
		try {
			const runtimeOptions: TerminalRuntimeOptions = { ...options, scrollback: this.scrollback };
			const runtime = new TerminalRuntimeSession(command, runtimeOptions);
			let entry: { id: string };
			try {
				entry = await this.registry.create({ command, session: runtime.session });
				if (!this.acceptingCreates) {
					await this.registry.stop(entry.id);
					throw new Error("Terminal manager is shutting down.");
				}
				if (this.activeSize + this.pendingCreates - 1 + this.getExternalSessionCount() > this.maxSessions) {
					await this.registry.stop(entry.id);
					throw new SessionRegistryCapacityError(this.maxSessions);
				}
			} catch (error) {
				runtime.dispose();
				runtime.session.kill();
				throw error;
			}
			this.runtimes.set(entry.id, runtime);
			this.reconcileRuntimes();
			return { id: entry.id, runtime };
		} finally {
			this.pendingCreates -= 1;
		}
	}

	/** Look up a live-or-exited session, refreshing its LRU timestamp. */
	get(id: string): TerminalRuntimeSession | null {
		const entry = this.registry.get(id);
		if (!entry) return null;
		return this.runtimes.get(id) ?? null;
	}

	list(): { id: string; runtime: TerminalRuntimeSession }[] {
		const result: { id: string; runtime: TerminalRuntimeSession }[] = [];
		for (const entry of this.registry.list()) {
			const runtime = this.runtimes.get(entry.id);
			if (runtime) result.push({ id: entry.id, runtime });
		}
		return result;
	}

	/** Tree-kill one session; the exited entry is kept for a final output read until swept. */
	async stop(id: string): Promise<boolean> {
		const stopped = await this.registry.stop(id);
		this.reconcileRuntimes();
		return stopped;
	}

	/** Tree-kill every session and dispose all runtime wrappers. */
	async teardown(): Promise<void> {
		this.acceptingCreates = false;
		await this.registry.teardown();
		for (const runtime of this.runtimes.values()) runtime.dispose();
		this.runtimes.clear();
	}

	/** Dispose runtime wrappers whose registry entry was pruned (capacity/LRU eviction). */
	private reconcileRuntimes(): void {
		const liveIds = new Set(this.registry.list().map((entry) => entry.id));
		for (const [id, runtime] of this.runtimes) {
			if (liveIds.has(id)) continue;
			runtime.dispose();
			this.runtimes.delete(id);
		}
	}
}

export function isCapacityError(error: unknown): error is SessionRegistryCapacityError {
	return error instanceof SessionRegistryCapacityError;
}
