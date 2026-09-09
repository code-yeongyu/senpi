import type { AgentToolResult } from "@code-yeongyu/senpi";
import { DEFAULT_HARD_LIMIT_SECONDS } from "../config/settings.ts";
import type { WakeSourceState } from "../extension/wake-source-state.ts";
import type {
	EvalDetachedCellManagerOptions,
	EvalDetachedCellSnapshot,
	EvalDetachedCellState,
	EvalDetachedCellStatusEntry,
} from "./detached-cell-contract.ts";
import { detachedNotificationSpillPath } from "./detached-cell-notification.ts";
import { currentDetachedResult, detachedErrorResult, snapshotDetachedCell } from "./detached-cell-snapshot.ts";
import {
	activeDetachedCellReuseError,
	allowsDetachedCellTransition,
	detachedCellIsActive,
} from "./detached-cell-state.ts";
import { detachedStatusEntries, detachedWakeSourceState } from "./detached-cell-status.ts";
import { DetachedNotificationQueue } from "./detached-notification-queue.ts";
import type { EvalKernel, EvalLanguage, EvalToolDetails, EvalToolInput } from "./types.ts";

export type {
	EvalDetachedCellManagerOptions,
	EvalDetachedCellNotification,
	EvalDetachedCellNotifier,
	EvalDetachedCellSnapshot,
	EvalDetachedCellState,
	EvalDetachedCellStatusEntry,
} from "./detached-cell-contract.ts";

type LiveResultProvider = () => AgentToolResult<EvalToolDetails>;

type ManagedCell = {
	readonly cellId: string;
	readonly input: EvalToolInput;
	readonly spillPath: string | undefined;
	readonly startedAtMs: number;
	readonly terminal: PromiseWithResolvers<EvalDetachedCellSnapshot>;
	state: EvalDetachedCellState;
	canDetach: boolean;
	wasDetached: boolean;
	kernel: EvalKernel | undefined;
	stateRetained: boolean | undefined;
	interruptNote: string | undefined;
	/** Holds the completion notification until the interrupt has reported whether kernel state survived. */
	interruptOutcome: PromiseWithResolvers<void> | undefined;
	liveResult: LiveResultProvider | undefined;
	terminalResult: AgentToolResult<EvalToolDetails> | undefined;
	notificationQueued: boolean;
	hardLimitSeconds: number;
	hardLimitTimer: ReturnType<typeof setTimeout> | undefined;
	hardLimited: boolean;
	onHardLimit: ((error: Error) => void) | undefined;
};

export function hardLimitError(cellId: string, hardLimitSeconds: number): Error {
	const error = new Error(`Eval cell ${cellId} was killed at the ${hardLimitSeconds}s hard limit.`);
	error.name = "TimeoutError";
	return error;
}

export class EvalDetachedCellManager {
	readonly #artifactsDir: string | undefined;
	readonly #onStatusChange: ((entries: readonly EvalDetachedCellStatusEntry[]) => void) | undefined;
	readonly #onWakeSourceState: ((state: WakeSourceState) => void) | undefined;
	readonly #cells = new Map<string, ManagedCell>();
	readonly #detachedByLanguage = new Map<EvalLanguage, ManagedCell>();
	readonly #notificationQueue: DetachedNotificationQueue;
	readonly #now: () => number;
	readonly #hardLimitSeconds: number;

	constructor(options: EvalDetachedCellManagerOptions = {}) {
		this.#artifactsDir = options.artifactsDir;
		this.#onStatusChange = options.onStatusChange;
		this.#onWakeSourceState = options.onWakeSourceState;
		this.#notificationQueue = new DetachedNotificationQueue(options.notifier);
		this.#now = options.now ?? Date.now;
		this.#hardLimitSeconds = options.hardLimitSeconds ?? DEFAULT_HARD_LIMIT_SECONDS;
	}

	create(cellId: string, input: EvalToolInput): ManagedCell {
		const existing = this.#cells.get(cellId);
		if (existing !== undefined) {
			if (detachedCellIsActive(existing.state)) throw activeDetachedCellReuseError(existing);
			this.#cells.delete(cellId);
		}
		const cell: ManagedCell = {
			cellId,
			input,
			spillPath: detachedNotificationSpillPath(this.#artifactsDir, cellId),
			startedAtMs: this.#now(),
			state: "running",
			canDetach: false,
			wasDetached: false,
			kernel: undefined,
			stateRetained: undefined,
			interruptNote: undefined,
			interruptOutcome: undefined,
			liveResult: undefined,
			terminalResult: undefined,
			notificationQueued: false,
			// An explicit longer per-call timeout raises the deadline, mirroring bash keeping explicit timeouts.
			hardLimitSeconds: Math.max(this.#hardLimitSeconds, input.timeout ?? 0),
			hardLimitTimer: undefined,
			hardLimited: false,
			onHardLimit: undefined,
			terminal: Promise.withResolvers<EvalDetachedCellSnapshot>(),
		};
		this.#cells.set(cellId, cell);
		this.#armHardLimit(cell);
		return cell;
	}

	markRunning(
		cell: ManagedCell,
		kernel: EvalKernel,
		liveResult: LiveResultProvider,
		/** Foreground killer: the still-awaited CellExecution owns interrupting and rejecting its own call. */
		onHardLimit?: (error: Error) => void,
	): void {
		if (cell.state !== "running") return;
		cell.onHardLimit = onHardLimit;
		cell.kernel = kernel;
		cell.liveResult = liveResult;
		cell.canDetach = true;
	}

	detach(cell: ManagedCell): boolean {
		if (!cell.canDetach || !allowsDetachedCellTransition(cell.state, "detached")) return false;
		cell.state = "detached";
		cell.wasDetached = true;
		this.#detachedByLanguage.set(cell.input.language, cell);
		this.#emitStatus();
		return true;
	}

	complete(cell: ManagedCell, result: AgentToolResult<EvalToolDetails>): boolean {
		return this.#settle(cell, result.details.isError === true ? "failed" : "completed", result);
	}

	fail(cell: ManagedCell, error: Error): boolean {
		return this.#settle(cell, "failed", detachedErrorResult(cell, error));
	}

	async stop(cellId: string, reason = "Stopped detached eval cell"): Promise<EvalDetachedCellSnapshot> {
		const cell = this.#get(cellId);
		if (cell.state === "detached") await this.#cancel(cell, reason);
		return this.#snapshot(cell);
	}

	peek(cellId: string): EvalDetachedCellSnapshot {
		return this.#snapshot(this.#get(cellId));
	}

	busyFor(language: EvalLanguage): EvalDetachedCellSnapshot | undefined {
		const cell = this.#detachedByLanguage.get(language);
		return cell === undefined ? undefined : this.#snapshot(cell);
	}

	async waitForTerminal(cellId: string): Promise<EvalDetachedCellSnapshot> {
		return await this.#get(cellId).terminal.promise;
	}

	async dispose(): Promise<void> {
		const detached = [...this.#detachedByLanguage.values()];
		await Promise.allSettled(
			detached.map(async (cell) => await this.stop(cell.cellId, "Session ended; detached eval cell cancelled")),
		);
		if (detached.length === 0) this.#emitWakeSourceState([]);
		await this.#notificationQueue.flush();
	}

	async flushNotifications(): Promise<void> {
		await this.#notificationQueue.flush();
	}

	/** Re-publish the current snapshot; consumers reset their per-source counts at session_start. */
	publishWakeSourceState(): void {
		this.#emitWakeSourceState([...this.#detachedByLanguage.values()]);
	}

	#settle(
		cell: ManagedCell,
		state: "completed" | "failed" | "cancelled",
		result: AgentToolResult<EvalToolDetails>,
	): boolean {
		if (!allowsDetachedCellTransition(cell.state, state)) return false;
		this.#clearHardLimit(cell);
		cell.state = state;
		cell.terminalResult = result;
		cell.liveResult = undefined;
		cell.terminal.resolve(this.#snapshot(cell));
		if (cell.wasDetached) {
			if (this.#detachedByLanguage.get(cell.input.language) === cell)
				this.#detachedByLanguage.delete(cell.input.language);
			this.#emitStatus();
			if (!cell.notificationQueued) {
				cell.notificationQueued = true;
				this.#notificationQueue.enqueue({
					snapshot: async () => {
						await cell.interruptOutcome?.promise;
						return this.#snapshot(cell);
					},
					spillPath: cell.spillPath,
				});
			}
		}
		return true;
	}

	#armHardLimit(cell: ManagedCell): void {
		const timer = setTimeout(() => void this.#expireHardLimit(cell), cell.hardLimitSeconds * 1_000);
		timer.unref?.();
		cell.hardLimitTimer = timer;
	}

	#clearHardLimit(cell: ManagedCell): void {
		if (cell.hardLimitTimer === undefined) return;
		clearTimeout(cell.hardLimitTimer);
		cell.hardLimitTimer = undefined;
	}

	/**
	 * The wall-clock kill deadline. Unlike the idle watchdog it is never paused by a bridge tool call and
	 * survives detach, so it is the only bound a detached cell has.
	 */
	async #expireHardLimit(cell: ManagedCell): Promise<void> {
		if (!detachedCellIsActive(cell.state)) return;
		const foreground = cell.state === "running" && cell.onHardLimit !== undefined;
		cell.hardLimited = true;
		const error = hardLimitError(cell.cellId, cell.hardLimitSeconds);
		if (foreground) {
			if (this.#settle(cell, "cancelled", currentDetachedResult(cell))) cell.onHardLimit?.(error);
			return;
		}
		await this.#cancel(cell, error.message);
	}

	async #cancel(cell: ManagedCell, reason: string): Promise<void> {
		const outcome = Promise.withResolvers<void>();
		cell.interruptOutcome = outcome;
		try {
			if (!this.#settle(cell, "cancelled", currentDetachedResult(cell)) || cell.kernel === undefined) return;
			const handle = await cell.kernel.interrupt(reason);
			cell.interruptNote = handle.note;
			cell.stateRetained = await handle.stateRetained;
		} finally {
			outcome.resolve();
		}
	}

	#emitStatus(): void {
		const liveCells = [...this.#detachedByLanguage.values()];
		this.#onStatusChange?.(detachedStatusEntries(liveCells));
		this.#emitWakeSourceState(liveCells);
	}

	#emitWakeSourceState(liveCells: readonly ManagedCell[]): void {
		this.#onWakeSourceState?.(detachedWakeSourceState(liveCells));
	}

	#snapshot(cell: ManagedCell): EvalDetachedCellSnapshot {
		return snapshotDetachedCell(cell, this.#now());
	}

	#get(cellId: string): ManagedCell {
		const cell = this.#cells.get(cellId);
		if (cell === undefined) throw new Error(`Unknown detached eval cell "${cellId}"`);
		return cell;
	}
}
