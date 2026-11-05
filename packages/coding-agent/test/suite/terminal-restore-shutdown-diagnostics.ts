import type { TerminalSession, TerminalSessionSignal } from "@earendil-works/pi-pty";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PersistenceState } from "../../src/core/extensions/builtin/terminal/restore-session.ts";

interface Phase {
	phase: string;
	pid?: number;
	signal?: TerminalSessionSignal;
	startedAt: number;
	finishedAt?: number;
	status: "pending" | "fulfilled" | "rejected";
}

interface Generation {
	generation: number;
	phases: Phase[];
}

type ShutdownState = Pick<PersistenceState, "keeper" | "restoreInFlight" | "manifestWriter" | "lease">;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Failure-only diagnostics for #4724. Observers preserve values/rejections, without deadlines. */
export class ShutdownDiagnostics {
	private readonly generations = new Map<object, Generation>();
	private readonly sessions = new Set<TerminalSession>();
	private readonly leases = new Set<string>();
	private active: Generation | undefined;

	register(generation: object): void {
		this.generations.set(generation, { generation: this.generations.size + 1, phases: [] });
	}

	observeSession(session: TerminalSession): void {
		this.sessions.add(session);
	}

	shutdown(generation: object, action: () => Promise<void>): Promise<void> {
		const entry = this.generations.get(generation);
		this.active = entry;
		const result = this.observe("shutdown", action);
		const clear = () => {
			if (this.active === entry) this.active = undefined;
		};
		return result.then(
			() => clear(),
			(error) => {
				clear();
				throw error;
			},
		);
	}

	observe<T>(phase: string, action: () => T, processInfo: { pid?: number; signal?: TerminalSessionSignal } = {}): T {
		if (!this.active) return action();
		const entry: Phase = { phase, ...processInfo, startedAt: Date.now(), status: "pending" };
		this.active.phases.push(entry);
		const finish = (status: "fulfilled" | "rejected") => {
			entry.status = status;
			entry.finishedAt = Date.now();
		};
		try {
			const result = action();
			if (result instanceof Promise)
				return result.then(
					(value) => {
						finish("fulfilled");
						return value;
					},
					(error) => {
						finish("rejected");
						throw error;
					},
				) as T;
			finish("fulfilled");
			return result;
		} catch (error) {
			finish("rejected");
			throw error;
		}
	}

	/** Interpose only on the existing shutdown awaits; bind methods to their real private-field owners. */
	persistence<T extends ShutdownState>(state: T): T {
		if (state.lease) this.leases.add(state.lease.path);
		return new Proxy(state, {
			get: (target, key, receiver) => {
				if (key === "restoreInFlight") return this.observe("restore", () => target.restoreInFlight);
				if (key === "keeper" && target.keeper) {
					const keeper = target.keeper;
					return new Proxy(keeper, {
						get: (owner, method) =>
							method === "settled"
								? () => this.observe("keeper", () => owner.settled())
								: Reflect.get(owner, method),
					});
				}
				if (key === "manifestWriter" && target.manifestWriter) {
					return new Proxy(target.manifestWriter, {
						get: (owner, method) => {
							if (method === "observeMonitorState")
								return (...args: Parameters<typeof owner.observeMonitorState>) =>
									this.observe("observe", () => owner.observeMonitorState(...args));
							if (method === "recordShutdown")
								return () => this.observe("recordShutdown", () => owner.recordShutdown());
							const value: unknown = Reflect.get(owner, method);
							return typeof value === "function" ? value.bind(owner) : value;
						},
					});
				}
				return Reflect.get(target, key, receiver);
			},
		});
	}

	snapshot(live: readonly object[], root: string, children: readonly { pid?: number }[], leasePath: string) {
		let socketPaths: string[] = [];
		let socketScanError: string | undefined;
		try {
			if (existsSync(root))
				socketPaths = readdirSync(root, { recursive: true, withFileTypes: true })
					.filter((entry) => entry.isSocket())
					.map((entry) => join(entry.parentPath, entry.name));
		} catch (error) {
			socketScanError = (error as NodeJS.ErrnoException).code;
		}
		return {
			generations: live.map((generation) => this.generations.get(generation)),
			processes: [
				...Array.from(this.sessions, (session) => ({
					pid: session.pid,
					exited: session.exited,
					exit: session.exitResult,
				})),
				...children.map((child) => ({ pid: child.pid })),
			].map((entry) => ({ ...entry, alive: entry.pid === undefined ? false : alive(entry.pid) })),
			leasePaths: [...new Set([leasePath, `${leasePath}.lock`, ...this.leases])].map((path) => ({
				path,
				exists: existsSync(path),
			})),
			socketPaths,
			socketScanRoot: root,
			socketScanError,
		};
	}
}
