import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { DEFAULT_RETAINED_IMAGES_MB, DEFAULT_RETAINED_RESULTS_MB } from "../config/memory-settings.ts";
import {
	DEFAULT_HARD_LIMIT_SECONDS,
	DEFAULT_MAX_DETACHED_CELLS,
	DEFAULT_RUN_BUDGET_SECONDS,
} from "../config/settings.ts";
import type { WakeSourceState } from "../extension/wake-source-state.ts";
import type { CellDeadlineExpiry } from "./cell-deadlines.ts";
import type {
	EvalDetachedCellManagerOptions,
	EvalDetachedCellSnapshot,
	EvalDetachedCellStatusEntry,
} from "./detached-cell-contract.ts";
import { cancelledDetachedResult, detachedErrorResult, snapshotDetachedCell } from "./detached-cell-snapshot.ts";
import {
	activeDetachedCellReuseError,
	allowsDetachedCellTransition,
	detachedCellIsActive,
} from "./detached-cell-state.ts";
import { detachedStatusEntries, detachedWakeSourceState } from "./detached-cell-status.ts";
import { DetachedNotificationQueue } from "./detached-notification-queue.ts";
import { createManagedCell, type LiveResultProvider, type ManagedCell } from "./managed-cell.ts";
import { SettledImageSpill } from "./settled-image-spill.ts";
import { TerminalSnapshotStore } from "./terminal-snapshot-store.ts";
import type { EvalKernel, EvalLanguage, EvalToolDetails, EvalToolInput } from "./types.ts";

export type {
	EvalDetachedCellManagerOptions,
	EvalDetachedCellNotification,
	EvalDetachedCellNotifier,
	EvalDetachedCellSnapshot,
	EvalDetachedCellState,
	EvalDetachedCellStatusEntry,
} from "./detached-cell-contract.ts";

export class EvalDetachedCellManager {
	readonly #onStatusChange: ((entries: readonly EvalDetachedCellStatusEntry[]) => void) | undefined;
	readonly #onWakeSourceState: ((state: WakeSourceState) => void) | undefined;
	readonly #cells = new Map<string, ManagedCell>();
	readonly #detached = new Map<string, ManagedCell>();
	readonly #terminalSnapshots: TerminalSnapshotStore;
	readonly #notificationQueue: DetachedNotificationQueue;
	readonly #now: () => number;
	readonly #hardLimitSeconds: number;
	readonly #runBudgetSeconds: number;
	readonly #maxDetachedCells: number;

	constructor(options: EvalDetachedCellManagerOptions = {}) {
		this.#onStatusChange = options.onStatusChange;
		this.#onWakeSourceState = options.onWakeSourceState;
		this.#notificationQueue = new DetachedNotificationQueue(options.notifier);
		this.#now = options.now ?? Date.now;
		this.#hardLimitSeconds = options.hardLimitSeconds ?? DEFAULT_HARD_LIMIT_SECONDS;
		this.#runBudgetSeconds = options.runBudgetSeconds ?? DEFAULT_RUN_BUDGET_SECONDS;
		this.#maxDetachedCells = options.maxDetachedCells ?? DEFAULT_MAX_DETACHED_CELLS;
		const artifactsDir = options.artifactsDir;
		this.#terminalSnapshots = new TerminalSnapshotStore({
			byteBudget: options.retainedResultsBytes ?? DEFAULT_RETAINED_RESULTS_MB * 1024 * 1024,
			...(artifactsDir === undefined
				? {}
				: {
						spill: new SettledImageSpill({
							dir: join(artifactsDir, "settled-images"),
							byteBudget: options.retainedImagesBytes ?? DEFAULT_RETAINED_IMAGES_MB * 1024 * 1024,
						}),
					}),
		});
	}

	get maxDetachedCells(): number {
		return this.#maxDetachedCells;
	}

	create(cellId: string, input: EvalToolInput, onKill?: (error: Error) => void): ManagedCell {
		const existing = this.#cells.get(cellId);
		if (existing !== undefined) {
			if (detachedCellIsActive(existing.state)) throw activeDetachedCellReuseError(existing);
			this.#cells.delete(cellId);
		}
		this.#terminalSnapshots.delete(cellId);
		const cell = createManagedCell({
			cellId,
			input,
			now: this.#now,
			defaultHardLimitSeconds: this.#hardLimitSeconds,
			defaultRunBudgetSeconds: this.#runBudgetSeconds,
			onKill,
			onExpire: (expiredId, expiry) => {
				const managed = this.#cells.get(expiredId);
				if (managed !== undefined) void this.#expireDeadline(managed, expiry);
			},
		});
		this.#cells.set(cellId, cell);
		return cell;
	}

	bindKernel(
		cell: ManagedCell,
		kernel: EvalKernel,
		liveResult: LiveResultProvider,
		onKill?: (error: Error) => void,
	): void {
		if (!detachedCellIsActive(cell.state)) return;
		cell.onKill = onKill ?? cell.onKill;
		cell.kernel = kernel;
		cell.liveResult = liveResult;
		cell.canDetach = true;
	}

	markRunning(cell: ManagedCell): void {
		if (!allowsDetachedCellTransition(cell.state, "running")) return;
		cell.state = "running";
		cell.runStartedAtMs = this.#now();
		cell.deadlines.resume();
		if (cell.detached) this.#emitStatus();
	}

	/** A host bridge call is in flight for this cell; its run budget stops charging until {@link resume}. */
	pause(cell: ManagedCell): void {
		cell.deadlines.pause();
	}

	resume(cell: ManagedCell): void {
		cell.deadlines.resume();
	}

	detach(cell: ManagedCell): boolean {
		if (
			!cell.canDetach ||
			!detachedCellIsActive(cell.state) ||
			cell.detached ||
			!(this.#detached.size < this.#maxDetachedCells)
		)
			return false;
		cell.detached = true;
		cell.wasDetached = true;
		this.#detached.set(cell.cellId, cell);
		this.#emitStatus();
		return true;
	}

	complete(cell: ManagedCell, result: AgentToolResult<EvalToolDetails>): boolean {
		const state =
			result.details.cells?.[0]?.status === "cancelled"
				? "cancelled"
				: result.details.isError === true
					? "failed"
					: "completed";
		return this.#settle(cell, state, result);
	}

	fail(cell: ManagedCell, error: Error): boolean {
		return this.#settle(cell, "failed", detachedErrorResult(cell, error));
	}

	async stop(cellId: string, reason = "Stopped detached eval cell"): Promise<EvalDetachedCellSnapshot> {
		const live = this.#cells.get(cellId);
		if (live === undefined) return this.#terminal(cellId);
		if (live.state === "queued") this.#cancelQueued(live, reason);
		else if (live.detached) await this.#cancel(live, reason);
		return this.#snapshot(live);
	}

	peek(cellId: string): EvalDetachedCellSnapshot {
		const live = this.#cells.get(cellId);
		return live === undefined ? this.#terminal(cellId) : this.#snapshot(live);
	}

	liveCells(language?: EvalLanguage, opts?: { except?: string }): readonly EvalDetachedCellSnapshot[] {
		return [...this.#cells.values()]
			.filter(
				(cell) =>
					detachedCellIsActive(cell.state) &&
					(language === undefined || cell.input.language === language) &&
					cell.cellId !== opts?.except,
			)
			.sort((a, b) => a.startedAtMs - b.startedAtMs)
			.map((cell) => this.#snapshot(cell));
	}

	list(): { live: readonly EvalDetachedCellSnapshot[]; recent: readonly EvalDetachedCellSnapshot[] } {
		return { live: this.liveCells(), recent: this.#terminalSnapshots.list() };
	}

	async waitForTerminal(cellId: string): Promise<EvalDetachedCellSnapshot> {
		const live = this.#cells.get(cellId);
		return live === undefined ? this.#terminal(cellId) : await live.terminal.promise;
	}

	async dispose(): Promise<void> {
		const detached = [...this.#detached.values()];
		// Dequeue first: interrupting an active run can synchronously start its next waiter.
		for (const cell of detached) {
			if (cell.state === "queued") this.#cancelQueued(cell, "Session ended; detached eval cell cancelled");
		}
		await Promise.allSettled(
			detached.map(async (cell) => await this.stop(cell.cellId, "Session ended; detached eval cell cancelled")),
		);
		if (detached.length === 0) this.#emitWakeSourceState([]);
		await this.#notificationQueue.flush();
		this.#cells.clear();
		this.#terminalSnapshots.clear();
	}

	async flushNotifications(): Promise<void> {
		await this.#notificationQueue.flush();
	}

	/** Re-publish the current snapshot; consumers reset their per-source counts at session_start. */
	publishWakeSourceState(): void {
		this.#emitWakeSourceState([...this.#detached.values()]);
	}

	#settle(
		cell: ManagedCell,
		state: "completed" | "failed" | "cancelled",
		result: AgentToolResult<EvalToolDetails>,
	): boolean {
		if (!allowsDetachedCellTransition(cell.state, state)) return false;
		cell.deadlines.clear();
		cell.state = state;
		cell.terminalResult = result;
		cell.liveResult = undefined;
		cell.terminal.resolve(this.#snapshot(cell));
		this.#cells.delete(cell.cellId);
		this.#refreshTerminalSnapshot(cell);
		if (cell.wasDetached) {
			this.#detached.delete(cell.cellId);
			this.#emitStatus();
			if (!cell.notificationQueued) {
				cell.notificationQueued = true;
				this.#notificationQueue.enqueue({
					snapshot: async () => {
						await cell.interruptOutcome?.promise;
						return this.#snapshot(cell);
					},
				});
			}
		}
		return true;
	}

	/**
	 * A kill deadline fired (see {@link CellDeadlines}). A foreground cell is killed through the
	 * CellExecution that still awaits it; a detached cell is cancelled here, which interrupts its kernel.
	 */
	async #expireDeadline(cell: ManagedCell, expiry: CellDeadlineExpiry): Promise<void> {
		if (!detachedCellIsActive(cell.state)) return;
		const foreground = !cell.detached && cell.onKill !== undefined;
		cell.hardLimited = expiry.kind === "hard-limit";
		cell.runBudgetExhausted = expiry.kind === "run-budget";
		if (cell.state === "queued") {
			this.#cancelQueued(cell, expiry.error.message, expiry.error);
			return;
		}
		if (foreground) {
			if (this.#settle(cell, "cancelled", cancelledDetachedResult(cell))) cell.onKill?.(expiry.error);
			return;
		}
		await this.#cancel(cell, expiry.error.message);
	}

	#cancelQueued(cell: ManagedCell, reason: string, error = new Error(reason)): void {
		const dequeued = cell.kernel?.cancelQueued(cell.cellId, reason) ?? false;
		cell.stateRetained = true;
		this.#settle(cell, "cancelled", cancelledDetachedResult(cell));
		// Acquisition/reset has no queue promise yet; its execution has no interrupt target either.
		if (!dequeued) cell.onKill?.(error);
	}

	async #cancel(cell: ManagedCell, reason: string): Promise<void> {
		const outcome = Promise.withResolvers<void>();
		cell.interruptOutcome = outcome;
		try {
			if (!this.#settle(cell, "cancelled", cancelledDetachedResult(cell)) || cell.kernel === undefined) return;
			const handle = await cell.kernel.interrupt(reason, cell.cellId);
			cell.interruptNote = handle.note;
			cell.stateRetained = await handle.stateRetained;
		} finally {
			outcome.resolve();
			this.#refreshTerminalSnapshot(cell);
		}
	}

	#refreshTerminalSnapshot(cell: ManagedCell): void {
		if (!this.#cells.has(cell.cellId)) this.#terminalSnapshots.remember(this.#snapshot(cell));
	}

	#emitStatus(): void {
		const liveCells = [...this.#detached.values()];
		this.#onStatusChange?.(detachedStatusEntries(liveCells));
		this.#emitWakeSourceState(liveCells);
	}

	#emitWakeSourceState(liveCells: readonly ManagedCell[]): void {
		this.#onWakeSourceState?.(detachedWakeSourceState(liveCells));
	}

	#snapshot(cell: ManagedCell): EvalDetachedCellSnapshot {
		return snapshotDetachedCell(cell, this.#now());
	}

	#terminal(cellId: string): EvalDetachedCellSnapshot {
		const snapshot = this.#terminalSnapshots.get(cellId);
		if (snapshot === undefined) throw new Error(`Unknown detached eval cell "${cellId}"`);
		return snapshot;
	}
}
