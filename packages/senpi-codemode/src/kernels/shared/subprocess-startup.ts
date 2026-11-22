import type { KernelToHostMessage } from "../../bridge/protocol.ts";

/**
 * How long a starting interpreter may stay completely still - no output line, no new startup stage, and
 * no CPU used by its process group - before startup fails. A cold Julia compiling its prelude prints
 * nothing for seconds but keeps the CPU busy, so it never trips; only a runner that is silent AND idle
 * (blocked on a lock, a pipe or a stopped process) does. It restarts on every sign of progress, so it is
 * not a total startup budget. Where the group's CPU cannot be read it never fires.
 */
export const subprocessStartupNoProgressMs = 30_000;

const STDERR_TAIL_CHARS = 2_000;
const stages = ["interpreter-launch", "stdlib-imports", "runtime-init", "host-init"] as const;
export type SubprocessStartupStage = (typeof stages)[number];

export interface SubprocessStartupOptions {
	readonly label: string;
	readonly noProgressMs?: number;
	/** CPU time used so far by a process group (any unit that only grows); `undefined` when unreadable. */
	readonly readGroupCpuTime?: (pgid: number) => bigint | undefined;
}

export class SubprocessStartupWatchdog {
	readonly #options: SubprocessStartupOptions;
	readonly #pid: number | undefined;
	readonly #onStall: (message: string) => void;
	readonly #noProgressMs: number;
	#stageIndex = 0;
	#stderrTail = "";
	#lastCpu: bigint | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#stopped = false;

	constructor(options: SubprocessStartupOptions, pid: number | undefined, onStall: (message: string) => void) {
		this.#options = options;
		this.#pid = pid;
		this.#onStall = onStall;
		this.#noProgressMs = options.noProgressMs ?? subprocessStartupNoProgressMs;
		this.#lastCpu = this.#readCpu();
		this.#arm();
	}

	/** Any message the runner sent before `ready` is progress; a later startup stage also moves the stage. */
	observe(message: KernelToHostMessage): void {
		if (this.#stopped) return;
		if (message.type === "status" && message.event.op === "kernel-startup") {
			const stage = stages.find((candidate) => candidate === message.event.stage);
			const next = stage === undefined ? -1 : stages.indexOf(stage);
			if (next > this.#stageIndex) this.#stageIndex = next;
		}
		if (message.type === "text" && message.stream === "stderr") {
			this.#stderrTail = (this.#stderrTail + message.data).slice(-STDERR_TAIL_CHARS);
		}
		this.#arm();
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#arm(): void {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.#expire(), this.#noProgressMs);
	}

	#expire(): void {
		if (this.#stopped) return;
		const cpu = this.#readCpu();
		// Unreadable CPU means busy and idle look the same: never cut a start off on silence alone.
		// Any change counts, a drop included: a member of the group exited, which is activity.
		if (cpu === undefined || cpu !== this.#lastCpu) {
			this.#lastCpu = cpu;
			this.#arm();
			return;
		}
		this.stop();
		const stage = stages[this.#stageIndex] ?? "interpreter-launch";
		const seconds = Math.round(this.#noProgressMs / 1000);
		const tail = this.#stderrTail.trim();
		this.#onStall(
			`${this.#options.label} kernel stalled at ${stage}: no output, stage change or CPU use for ${seconds} s${tail ? `; stderr: ${tail}` : ""}`,
		);
	}

	#readCpu(): bigint | undefined {
		return this.#pid === undefined ? undefined : this.#options.readGroupCpuTime?.(this.#pid);
	}
}
