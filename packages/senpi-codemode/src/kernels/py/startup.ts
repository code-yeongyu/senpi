import type { KernelToHostMessage } from "../../bridge/protocol.ts";

/**
 * How long a starting interpreter may stay completely still before startup fails: no new stage, no output
 * line, and no CPU used. A cold, contended interpreter importing the stdlib emits nothing for seconds but
 * keeps the CPU busy, so it never trips; only one that is silent AND idle does. Fresh-cache Windows
 * bootstraps measured p99 5,220 ms of mostly import time (Actions run 36882163342), so 11 s of complete
 * stillness is a stall, not a slow start.
 */
export const pythonStartupHangGuardMs = 11_000;

/**
 * Total startup budget, a backstop for an interpreter that keeps burning CPU without ever reaching
 * `ready` (a livelock). Over twenty times the slowest measured cold start; never reached by a real one.
 */
export const pythonStartupCeilingMs = 120_000;

const stages = ["interpreter-launch", "stdlib-imports", "runtime-init", "host-init"] as const;
export type PythonStartupStage = (typeof stages)[number];

export class PythonKernelStartupError extends Error {
	readonly stage: PythonStartupStage;

	constructor(stage: PythonStartupStage, reason: string, cause?: Error) {
		super(`Python kernel startup failed at ${stage}: ${reason}`, { cause });
		this.name = "PythonKernelStartupError";
		this.stage = stage;
	}
}

export interface PythonStartupOptions {
	readonly noProgressMs: number;
	readonly ceilingMs: number;
	readonly failureDetail: () => string;
	/** CPU used so far by the interpreter (any unit that only grows); `undefined` when unreadable. */
	readonly readCpuTime: () => bigint | undefined;
}

export class PythonStartup {
	readonly #options: PythonStartupOptions;
	readonly #ready = Promise.withResolvers<void>();
	readonly ready = this.#ready.promise;
	readonly #ceiling: NodeJS.Timeout;
	#timer: NodeJS.Timeout | undefined;
	#stageIndex = 0;
	#lastCpu: bigint | undefined;
	#settled = false;

	constructor(options: PythonStartupOptions) {
		this.#options = options;
		this.#ceiling = setTimeout(
			() => this.#fail(`not ready after ${Math.round(options.ceilingMs / 1000)} s`),
			options.ceilingMs,
		);
		this.#arm();
	}

	progress(message: KernelToHostMessage): PythonStartupStage | undefined {
		if (this.#settled || message.type !== "status" || message.event.op !== "kernel-startup") return;
		const stage = stages.find((candidate) => candidate === message.event.stage);
		if (stage === undefined) return;
		const next = stages.indexOf(stage);
		if (next <= this.#stageIndex) return;
		this.#stageIndex = next;
		this.#arm();
		return stage;
	}

	activity(): void {
		if (!this.#settled) this.#arm();
	}

	settle(error?: Error): boolean {
		if (this.#settled) return false;
		this.#settled = true;
		clearTimeout(this.#timer);
		clearTimeout(this.#ceiling);
		if (error) {
			this.#ready.reject(
				error instanceof PythonKernelStartupError
					? error
					: new PythonKernelStartupError(this.#stage(), error.message, error),
			);
		} else this.#ready.resolve();
		return true;
	}

	#arm(): void {
		this.#lastCpu = this.#options.readCpuTime();
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.#expire(), this.#options.noProgressMs);
	}

	#expire(): void {
		if (this.#settled) return;
		const cpu = this.#options.readCpuTime();
		// Where CPU can't be read, stage and output are the only signs of life, as before.
		if (cpu !== undefined && cpu !== this.#lastCpu) {
			this.#arm();
			return;
		}
		this.#fail(`no output, stage change or CPU use for ${this.#options.noProgressMs}ms`);
	}

	#fail(reason: string): void {
		const detail = this.#options.failureDetail().trim();
		this.settle(new PythonKernelStartupError(this.#stage(), `${reason}${detail ? `; ${detail}` : ""}`));
	}

	#stage(): PythonStartupStage {
		return stages[this.#stageIndex] ?? "interpreter-launch";
	}
}
