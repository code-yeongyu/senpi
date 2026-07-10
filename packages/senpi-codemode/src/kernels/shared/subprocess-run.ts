import type { KernelResult, KernelRunInput } from "./subprocess-kernel.ts";

export interface PendingRun {
	readonly input: KernelRunInput;
	readonly resolve: (message: KernelResult) => void;
	timer: NodeJS.Timeout | null;
	startedAt: number | null;
	settled: boolean;
}

export class KernelClosedError extends Error {
	constructor() {
		super("Kernel is closed");
		this.name = "KernelClosedError";
	}
}

export class KernelStartupError extends Error {
	constructor(message: string) {
		super(`Kernel startup failed: ${message}`);
		this.name = "KernelStartupError";
	}
}

export class KernelRetirementError extends Error {
	constructor() {
		super("Kernel process did not exit after SIGKILL");
		this.name = "KernelRetirementError";
	}
}

export class KernelExitedError extends Error {
	constructor(status: string | number) {
		super(`Kernel exited before completing the cell (${status})`);
		this.name = "KernelExitedError";
	}
}

export class KernelProcessError extends Error {
	constructor(message: string) {
		super(`Kernel process error: ${message}`);
		this.name = "KernelProcessError";
	}
}

export class CellInterruptedError extends Error {
	constructor(reason: string) {
		super(reason === "Eval interrupted" ? reason : `Eval interrupted: ${reason}`);
		this.name = "CellInterruptedError";
	}
}

export class KernelResetError extends Error {
	constructor() {
		super("Kernel reset");
		this.name = "KernelResetError";
	}
}

export class KernelClosingError extends Error {
	constructor() {
		super("Kernel closed");
		this.name = "KernelClosingError";
	}
}

export function createPendingRun(input: KernelRunInput, resolve: (message: KernelResult) => void): PendingRun {
	return { input, resolve, timer: null, startedAt: null, settled: false };
}

export function failureResult(run: PendingRun, error: Error): KernelResult {
	return {
		type: "result",
		cellId: run.input.cellId,
		ok: false,
		error: { message: error.message },
		durationMs: run.startedAt === null ? 0 : Math.max(0, Math.round(performance.now() - run.startedAt)),
	};
}

export function timeoutResult(run: PendingRun, timeoutMs: number): KernelResult {
	return {
		type: "result",
		cellId: run.input.cellId,
		ok: false,
		error: { message: `Cell timed out after ${timeoutMs}ms` },
		durationMs: timeoutMs,
	};
}

export function settlePendingRun(run: PendingRun, result: KernelResult): boolean {
	if (run.settled) return false;
	run.settled = true;
	if (run.timer) clearTimeout(run.timer);
	run.timer = null;
	run.resolve(result);
	return true;
}
