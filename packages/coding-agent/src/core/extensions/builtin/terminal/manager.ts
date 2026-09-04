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
	/** Stable "mon_" identities bound to runtime session ids; survives PTY exit, then drops on session prune or teardown. */
	private readonly monitorIds = new Map<string, string>();
	private readonly scrollback?: number;
	private readonly maxSessions: number;
	private readonly exited = new Set<string>();
	private reservations = 0;

	constructor(options: TerminalManagerOptions = {}) {
		this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
		this.registry = new SessionRegistry<TerminalSession>({ maxSessions: this.maxSessions });
		this.scrollback = options.scrollback;
	}

	get size(): number {
		return this.runtimes.size;
	}

	get activeSize(): number {
		this.reconcileRuntimes();
		return this.runtimes.size - this.exited.size + this.reservations;
	}

	reserve(): (() => void) | null {
		this.reconcileRuntimes();
		if (this.runtimes.size - this.exited.size + this.reservations >= this.maxSessions) return null;
		this.reservations += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.reservations -= 1;
		};
	}

	/** Spawn a new terminal session and register it under an allocated `bash_N` id. */
	async create(command: string, options: TerminalSessionOptions): Promise<CreatedTerminalSession> {
		const release = this.reserve();
		if (!release) throw new SessionRegistryCapacityError(this.maxSessions);
		const runtimeOptions: TerminalRuntimeOptions = { ...options, scrollback: this.scrollback };
		const runtime = new TerminalRuntimeSession(command, runtimeOptions);
		let entry: { id: string };
		try {
			entry = await this.registry.create({ command, session: runtime.session });
		} catch (error) {
			release();
			runtime.dispose();
			runtime.session.kill();
			throw error;
		}
		this.runtimes.set(entry.id, runtime);
		runtime.session.onExit(() => {
			this.exited.add(entry.id);
		});
		release();
		this.reconcileRuntimes();
		return { id: entry.id, runtime };
	}

	/** Look up a live-or-exited session, refreshing its LRU timestamp. */
	get(id: string): TerminalRuntimeSession | null {
		const entry = this.registry.get(id);
		if (!entry) return null;
		return this.runtimes.get(id) ?? null;
	}

	/** Bind a stable "mon_" id to its runtime session id; a later restore re-binds the same id. */
	bindMonitorId(monitorId: string, sessionId: string): void {
		this.monitorIds.set(monitorId, sessionId);
	}

	/**
	 * Resolve a "mon_" monitor id to its current runtime "bash_N" (or "watch_N"), passing a
	 * runtime id through unchanged; undefined when neither resolves. Bindings intentionally
	 * outlive PTY exit for a final output read, then drop when the session is pruned or torn down.
	 */
	resolveId(idOrMonitorId: string): string | undefined {
		if (idOrMonitorId.startsWith("mon_")) return this.monitorIds.get(idOrMonitorId);
		return this.registry.get(idOrMonitorId) ? idOrMonitorId : undefined;
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
		await this.registry.teardown();
		for (const runtime of this.runtimes.values()) runtime.dispose();
		this.runtimes.clear();
		this.exited.clear();
		this.monitorIds.clear();
	}

	/** Dispose runtime wrappers whose registry entry was pruned (capacity/LRU eviction). */
	private reconcileRuntimes(): void {
		const liveIds = new Set(this.registry.list().map((entry) => entry.id));
		for (const [id, runtime] of this.runtimes) {
			if (liveIds.has(id)) continue;
			runtime.dispose();
			this.runtimes.delete(id);
			this.exited.delete(id);
			for (const [monitorId, sessionId] of this.monitorIds) {
				if (sessionId === id) this.monitorIds.delete(monitorId);
			}
		}
	}
}

export function isCapacityError(error: unknown): error is SessionRegistryCapacityError {
	return error instanceof SessionRegistryCapacityError;
}
