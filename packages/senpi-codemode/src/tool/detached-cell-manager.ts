import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import type { EvalKernel, EvalLanguage, EvalToolDetails, EvalToolInput } from "./types.ts";

const NOTIFICATION_TAIL_BYTES = 512;

export type EvalDetachedCellState = "running" | "detached" | "completed" | "failed" | "cancelled";

type ManagedCell = {
	readonly cellId: string;
	readonly input: EvalToolInput;
	readonly spillPath: string | undefined;
	readonly startedAtMs: number;
	state: EvalDetachedCellState;
	canDetach: boolean;
	wasDetached: boolean;
	kernel: EvalKernel | undefined;
	/** Set after an interrupt-driven stop; undefined until the kernel reports its fate. */
	stateRetained: boolean | undefined;
	outputTail: (() => string) | undefined;
	result: AgentToolResult<EvalToolDetails> | undefined;
	notificationQueued: boolean;
	readonly terminal: PromiseWithResolvers<EvalDetachedCellSnapshot>;
};

export interface EvalDetachedCellSnapshot {
	readonly cellId: string;
	readonly language: EvalLanguage;
	readonly state: EvalDetachedCellState;
	readonly outputTail: string;
	readonly result: AgentToolResult<EvalToolDetails> | undefined;
	readonly stateRetained: boolean | undefined;
}

export interface EvalDetachedCellNotification {
	readonly cellId: string;
	readonly content: string;
}

export interface EvalDetachedCellNotifier {
	notify(cells: readonly EvalDetachedCellNotification[]): void;
}

/** One live detached cell, as shown in the footer status line. */
export interface EvalDetachedCellStatusEntry {
	readonly cellId: string;
	readonly language: EvalLanguage;
	readonly title?: string;
	/** Epoch milliseconds when the cell was created; feeds the footer's live elapsed label. */
	readonly startedAtMs: number;
}

export interface EvalDetachedCellManagerOptions {
	readonly artifactsDir?: string;
	readonly notifier?: EvalDetachedCellNotifier;
	/** Called with every detached cell whenever that set changes; empty clears the status. */
	readonly onStatusChange?: (entries: readonly EvalDetachedCellStatusEntry[]) => void;
	/** Injectable clock for tests; defaults to Date.now. */
	readonly now?: () => number;
}

/**
 * Session-owned lifecycle owner for eval cells that outlive their tool call.
 *
 * All state changes are synchronous and funnel through #transition. That is the
 * atomic boundary for timeout, kernel completion, explicit stop, and session
 * disposal races; exactly one path can release a language's detached busy mark.
 */
export class EvalDetachedCellManager {
	readonly #artifactsDir: string | undefined;
	readonly #notifier: EvalDetachedCellNotifier | undefined;
	readonly #onStatusChange: ((entries: readonly EvalDetachedCellStatusEntry[]) => void) | undefined;
	readonly #cells = new Map<string, ManagedCell>();
	readonly #detachedByLanguage = new Map<EvalLanguage, ManagedCell>();
	readonly #now: () => number;
	#notificationQueue: ManagedCell[] = [];
	#notificationFlush: Promise<void> | undefined;

	constructor(options: EvalDetachedCellManagerOptions = {}) {
		this.#artifactsDir = options.artifactsDir;
		this.#notifier = options.notifier;
		this.#onStatusChange = options.onStatusChange;
		this.#now = options.now ?? Date.now;
	}

	create(cellId: string, input: EvalToolInput): ManagedCell {
		const existing = this.#cells.get(cellId);
		if (existing !== undefined) {
			if (existing.state === "running" || existing.state === "detached") throw activeCellReuseError(existing);
			this.#cells.delete(cellId);
		}
		const spillPath =
			this.#artifactsDir === undefined
				? undefined
				: join(this.#artifactsDir, "local", `detached-eval-${safeCellId(cellId)}.log`);
		const cell: ManagedCell = {
			cellId,
			input,
			spillPath,
			startedAtMs: this.#now(),
			state: "running",
			canDetach: false,
			wasDetached: false,
			kernel: undefined,
			stateRetained: undefined,
			outputTail: undefined,
			result: undefined,
			notificationQueued: false,
			terminal: Promise.withResolvers<EvalDetachedCellSnapshot>(),
		};
		this.#cells.set(cellId, cell);
		return cell;
	}

	markRunning(cell: ManagedCell, kernel: EvalKernel, outputTail: () => string): void {
		if (cell.state !== "running") return;
		cell.kernel = kernel;
		cell.outputTail = outputTail;
		cell.canDetach = true;
	}

	detach(cell: ManagedCell): boolean {
		if (!cell.canDetach || !this.#transition(cell, "detached")) return false;
		cell.wasDetached = true;
		this.#detachedByLanguage.set(cell.input.language, cell);
		this.#emitStatus();
		return true;
	}

	complete(cell: ManagedCell, result: AgentToolResult<EvalToolDetails>): boolean {
		cell.result = result;
		return this.#transition(cell, result.details.isError === true ? "failed" : "completed");
	}

	fail(cell: ManagedCell, error: Error): boolean {
		const result = errorResult(cell, error);
		cell.result = result;
		return this.#transition(cell, "failed");
	}

	async stop(cellId: string, reason = "Stopped detached eval cell"): Promise<EvalDetachedCellSnapshot> {
		const cell = this.#get(cellId);
		if (cell.state === "detached" && this.#transition(cell, "cancelled")) {
			const kernel = cell.kernel;
			if (kernel !== undefined) {
				const handle = await kernel.interrupt(reason);
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
		await this.flushNotifications();
	}

	async flushNotifications(): Promise<void> {
		const flush = this.#notificationFlush;
		if (flush !== undefined) await flush;
	}

	#transition(cell: ManagedCell, next: EvalDetachedCellState): boolean {
		if (!allowsTransition(cell.state, next)) return false;
		cell.state = next;
		if (next !== "running" && next !== "detached") cell.terminal.resolve(this.#snapshot(cell));
		if (cell.wasDetached && next !== "detached") {
			if (this.#detachedByLanguage.get(cell.input.language) === cell)
				this.#detachedByLanguage.delete(cell.input.language);
			this.#emitStatus();
			this.#queueNotification(cell);
		}
		return true;
	}

	#emitStatus(): void {
		const emit = this.#onStatusChange;
		if (emit === undefined) return;
		emit(
			[...this.#detachedByLanguage.values()].map((cell) => ({
				cellId: cell.cellId,
				language: cell.input.language,
				startedAtMs: cell.startedAtMs,
				...(cell.input.title === undefined ? {} : { title: cell.input.title }),
			})),
		);
	}

	#queueNotification(cell: ManagedCell): void {
		if (cell.notificationQueued) return;
		cell.notificationQueued = true;
		this.#notificationQueue.push(cell);
		this.#scheduleNotificationFlush();
	}

	#scheduleNotificationFlush(): void {
		if (this.#notificationFlush !== undefined) return;
		const flush = Promise.resolve().then(async () => {
			const cells = this.#notificationQueue.splice(0);
			const notifications = await Promise.all(cells.map(async (candidate) => await this.#notification(candidate)));
			this.#notifier?.notify(notifications);
		});
		this.#notificationFlush = flush;
		void flush.then(
			() => this.#finishNotificationFlush(flush),
			() => this.#finishNotificationFlush(flush),
		);
	}

	#finishNotificationFlush(flush: Promise<void>): void {
		if (this.#notificationFlush !== flush) return;
		this.#notificationFlush = undefined;
		if (this.#notificationQueue.length > 0) this.#scheduleNotificationFlush();
	}

	async #notification(cell: ManagedCell): Promise<EvalDetachedCellNotification> {
		const snapshot = this.#snapshot(cell);
		const body = notificationBody(snapshot);
		const overflow = Buffer.byteLength(body, "utf8") > NOTIFICATION_TAIL_BYTES;
		let spillNotice = "";
		if (overflow && cell.spillPath !== undefined) {
			try {
				await mkdir(dirname(cell.spillPath), { recursive: true });
				await writeFile(cell.spillPath, body, "utf8");
				spillNotice = `\nBuffered output overflowed; full output: ${localUri(cell.spillPath, this.#artifactsDir)}`;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				spillNotice = `\nBuffered output overflow could not be spilled: ${message}`;
			}
		}
		return {
			cellId: cell.cellId,
			content: `${overflow ? notificationPreview(snapshot) : body}${overflow ? "\n[…notification tail capped…]" : ""}${spillNotice}`,
		};
	}

	#get(cellId: string): ManagedCell {
		const cell = this.#cells.get(cellId);
		if (cell === undefined) throw new Error(`Unknown detached eval cell "${cellId}"`);
		return cell;
	}

	#snapshot(cell: ManagedCell): EvalDetachedCellSnapshot {
		return {
			cellId: cell.cellId,
			language: cell.input.language,
			state: cell.state,
			outputTail: cell.outputTail?.() ?? "",
			result: cell.result,
			stateRetained: cell.stateRetained,
		};
	}
}

function activeCellReuseError(cell: ManagedCell): Error {
	return new Error(
		`Eval cell ${cell.cellId} from a previous call is still ${cell.state} in the ${cell.input.language} kernel. Use eval({ action: "peek", cell_id: "${cell.cellId}" }) to read it or eval({ action: "stop", cell_id: "${cell.cellId}" }) to end it before its id can be reused.`,
	);
}

function allowsTransition(from: EvalDetachedCellState, to: EvalDetachedCellState): boolean {
	if (from === "running") return to === "detached" || to === "completed" || to === "failed" || to === "cancelled";
	if (from === "detached") return to === "completed" || to === "failed" || to === "cancelled";
	return false;
}

function errorResult(cell: ManagedCell, error: Error): AgentToolResult<EvalToolDetails> {
	const output = cell.outputTail?.() ?? "";
	return {
		content: [{ type: "text", text: output.length > 0 ? `${output}\n${error.message}` : error.message }],
		details: {
			language: cell.input.language,
			languages: [cell.input.language],
			durationMs: 0,
			toolCalls: [],
			truncated: false,
			isError: true,
			cells: [
				{
					index: 0,
					code: cell.input.code,
					language: cell.input.language,
					output,
					status: "error",
				},
			],
		},
	};
}

function notificationBody(cell: EvalDetachedCellSnapshot): string {
	const outcome = cell.state === "completed" ? "completed" : cell.state === "cancelled" ? "cancelled" : "failed";
	const resultText =
		cell.result?.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n") ?? cell.outputTail;
	const stateNote =
		cell.state === "cancelled" && cell.language === "js"
			? "JavaScript worker was restarted; VM state was lost."
			: cell.state === "cancelled" && cell.language === "py"
				? "Python kernel was interrupted; its existing variables are preserved."
				: "Kernel state updated - variables are available to the next eval cell.";
	return [
		`<system-reminder>Detached eval cell ${cell.cellId} (${cell.language}) ${outcome}.`,
		resultText.length === 0 ? "(no output)" : resultText,
		`${stateNote}</system-reminder>`,
	].join("\n");
}

function notificationPreview(cell: EvalDetachedCellSnapshot): string {
	const outcome = cell.state === "completed" ? "completed" : cell.state === "cancelled" ? "cancelled" : "failed";
	const resultText =
		cell.result?.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n") ?? cell.outputTail;
	const stateNote =
		cell.state === "cancelled" && cell.language === "js"
			? "JavaScript worker was restarted; VM state was lost."
			: cell.state === "cancelled" && cell.language === "py"
				? "Python kernel was interrupted; its existing variables are preserved."
				: "Kernel state updated - variables are available to the next eval cell.";
	return [
		`<system-reminder>Detached eval cell ${cell.cellId} (${cell.language}) ${outcome}.`,
		"Buffered output tail:",
		truncateTailUtf8(resultText, NOTIFICATION_TAIL_BYTES),
		`${stateNote}</system-reminder>`,
	].join("\n");
}

function safeCellId(cellId: string): string {
	return cellId.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

function localUri(path: string, artifactsDir: string | undefined): string {
	if (artifactsDir === undefined) return `local://${path}`;
	const root = join(artifactsDir, "local");
	return path.startsWith(`${root}/`) ? `local://${path.slice(root.length + 1)}` : `local://${path}`;
}

function truncateTailUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const bytes = Buffer.from(text, "utf8");
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}
