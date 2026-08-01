import type { AgentToolResult } from "@code-yeongyu/senpi";
import { detachedNotificationSpillPath } from "./detached-cell-notification.ts";
import { currentDetachedResult, detachedErrorResult, snapshotDetachedCell } from "./detached-cell-snapshot.ts";
import {
	activeDetachedCellReuseError,
	allowsDetachedCellTransition,
	detachedCellIsActive,
} from "./detached-cell-state.ts";
import { DetachedNotificationQueue } from "./detached-notification-queue.ts";
import type { EvalKernel, EvalLanguage, EvalToolDetails, EvalToolInput } from "./types.ts";

export type EvalDetachedCellState = "running" | "detached" | "completed" | "failed" | "cancelled";

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
	liveResult: LiveResultProvider | undefined;
	terminalResult: AgentToolResult<EvalToolDetails> | undefined;
	notificationQueued: boolean;
};

export interface EvalDetachedCellSnapshot {
	readonly cellId: string;
	readonly language: EvalLanguage;
	readonly state: EvalDetachedCellState;
	readonly outputTail: string;
	readonly result: AgentToolResult<EvalToolDetails>;
	readonly stateRetained: boolean | undefined;
}

export interface EvalDetachedCellNotification {
	readonly cellId: string;
	readonly content: string;
}

export interface EvalDetachedCellNotifier {
	notify(cells: readonly EvalDetachedCellNotification[]): void;
}

export interface EvalDetachedCellStatusEntry {
	readonly cellId: string;
	readonly language: EvalLanguage;
	readonly title?: string;
	readonly startedAtMs: number;
}

export interface EvalDetachedCellManagerOptions {
	readonly artifactsDir?: string;
	readonly notifier?: EvalDetachedCellNotifier;
	readonly onStatusChange?: (entries: readonly EvalDetachedCellStatusEntry[]) => void;
	readonly now?: () => number;
}

export class EvalDetachedCellManager {
	readonly #artifactsDir: string | undefined;
	readonly #onStatusChange: ((entries: readonly EvalDetachedCellStatusEntry[]) => void) | undefined;
	readonly #cells = new Map<string, ManagedCell>();
	readonly #detachedByLanguage = new Map<EvalLanguage, ManagedCell>();
	readonly #notificationQueue: DetachedNotificationQueue;
	readonly #now: () => number;

	constructor(options: EvalDetachedCellManagerOptions = {}) {
		this.#artifactsDir = options.artifactsDir;
		this.#onStatusChange = options.onStatusChange;
		this.#notificationQueue = new DetachedNotificationQueue(options.notifier, options.artifactsDir);
		this.#now = options.now ?? Date.now;
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
			liveResult: undefined,
			terminalResult: undefined,
			notificationQueued: false,
			terminal: Promise.withResolvers<EvalDetachedCellSnapshot>(),
		};
		this.#cells.set(cellId, cell);
		return cell;
	}

	markRunning(cell: ManagedCell, kernel: EvalKernel, liveResult: LiveResultProvider): void {
		if (cell.state !== "running") return;
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
		if (cell.state === "detached") {
			const claimed = this.#settle(cell, "cancelled", currentDetachedResult(cell));
			if (claimed && cell.kernel !== undefined) {
				const handle = await cell.kernel.interrupt(reason);
				cell.stateRetained = await handle.stateRetained;
			}
		}
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
		await this.#notificationQueue.flush();
	}

	async flushNotifications(): Promise<void> {
		await this.#notificationQueue.flush();
	}

	#settle(
		cell: ManagedCell,
		state: "completed" | "failed" | "cancelled",
		result: AgentToolResult<EvalToolDetails>,
	): boolean {
		if (!allowsDetachedCellTransition(cell.state, state)) return false;
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
					snapshot: () => this.#snapshot(cell),
					spillPath: cell.spillPath,
				});
			}
		}
		return true;
	}

	#emitStatus(): void {
		this.#onStatusChange?.(
			[...this.#detachedByLanguage.values()].map((cell) => ({
				cellId: cell.cellId,
				language: cell.input.language,
				startedAtMs: cell.startedAtMs,
				...(cell.input.title === undefined ? {} : { title: cell.input.title }),
			})),
		);
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
