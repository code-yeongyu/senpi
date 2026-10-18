import type { HostToKernelMessage } from "../bridge/protocol.ts";
import {
	type KernelLifecycle,
	KernelUnavailableError,
	restartNotice,
	unstartedResult,
} from "../kernels/shared/kernel-death.ts";
import type {
	EvalKernel,
	EvalKernelResult,
	EvalKernelRunInput,
	EvalLanguage,
	KernelInterruptHandle,
	PendingCell,
} from "../tool/types.ts";
import { hasKernelTools, type KernelToolsMethods } from "./kernel-tools-probe.ts";

export type StartKernel = (lifecycle: Required<KernelLifecycle>) => Promise<EvalKernel>;

class ReplaceableKernelClosedError extends Error {
	readonly name = "ReplaceableKernelClosedError";

	constructor() {
		super("Kernel closed");
	}
}

/**
 * The one kernel a session holds for a language whose instances can die (py, rb, jl). Every caller keeps
 * this object for the life of a cell - its handler, its execution, its detached record - so a death never
 * strands them: on the instance's own death event this evicts it, takes back the cells that never started,
 * starts ONE replacement and runs them there in their original order, with their own callbacks. The first
 * result of the replacement says the kernel was restarted. A replacement that dies before it finished a
 * cell is not replaced again for the same cells: they fail with `eval_kernel_unavailable`, and the next
 * cell submitted starts a fresh one. The cell that was running when the interpreter died is never re-run.
 */
export class ReplaceableKernel implements EvalKernel {
	readonly #language: EvalLanguage;
	readonly #start: StartKernel;
	#kernel: EvalKernel;
	#generation = 0;
	#nextGeneration = 0;
	#held: PendingCell[] = [];
	#replacing: Promise<void> | null = null;
	/** The death the current instance replaced, until that instance settled a cell of its own. */
	#recovering: string | null = null;
	/** A death whose cells were failed instead of replaced: the next cell's fresh instance announces it. */
	#unannounced: string | null = null;
	/** Carried by the first result the current replacement produces. */
	#announce: string | null = null;
	#closed = false;
	#closeFailure: unknown;

	// Present only when the instance has kernel tools, so a probe sees what it would see on the instance itself.
	declare readonly describeKernelTools?: KernelToolsMethods["describeKernelTools"];
	declare readonly invokeKernelTool?: KernelToolsMethods["invokeKernelTool"];

	private constructor(language: EvalLanguage, start: StartKernel, first: EvalKernel) {
		this.#language = language;
		this.#start = start;
		this.#kernel = first;
		// Python is the one subprocess kernel with kernel tools; rb and jl only carry tools_unavailable stubs to hide.
		if (language === "py" && hasKernelTools(first)) {
			// Always the CURRENT instance: after a replacement the old definitions are gone with the old interpreter.
			const tools: KernelToolsMethods = {
				describeKernelTools: (names) => this.#currentTools().describeKernelTools(names),
				invokeKernelTool: (request, options) => this.#currentTools().invokeKernelTool(request, options),
			};
			Object.assign(this, tools);
		}
	}

	#currentTools(): KernelToolsMethods {
		const current = this.#kernel;
		if (!hasKernelTools(current)) throw new Error(`The ${this.#language} kernel has no kernel tools`);
		return current;
	}

	/** Starts the first instance; one that cannot hand back its queue is returned as it is. */
	static async create(language: EvalLanguage, start: StartKernel): Promise<EvalKernel> {
		let owner: ReplaceableKernel | undefined;
		const first = await start({
			onDeath: (reason) => {
				if (owner !== undefined) owner.#died(0, reason);
			},
		});
		if (first.drainPending === undefined) return first;
		owner = new ReplaceableKernel(language, start, first);
		return owner;
	}

	run(input: EvalKernelRunInput): Promise<EvalKernelResult> {
		if (this.#closed) return Promise.reject(new ReplaceableKernelClosedError());
		if (this.#replacing === null && this.#kernel.isAlive?.() !== false) {
			return this.#submit(this.#generation, this.#kernel, input);
		}
		return new Promise((settle) => {
			this.#held.push({ input, settle });
			this.#ensureReplacement();
		});
	}

	cancelQueued(cellId: string, reason: string): boolean {
		return this.#cancelHeld(cellId, reason) || this.#kernel.cancelQueued(cellId, reason);
	}

	async interrupt(reason = "interrupted", cellId?: string): Promise<KernelInterruptHandle> {
		if (cellId !== undefined && this.#cancelHeld(cellId, reason)) return { stateRetained: Promise.resolve(true) };
		if (cellId === undefined) this.#failHeld(reason === "Eval interrupted" ? reason : `Eval interrupted: ${reason}`);
		return await this.#kernel.interrupt(reason, cellId);
	}

	queueSnapshot(): { activeCellId: string | null; queuedCellIds: readonly string[] } {
		const current = this.#kernel.queueSnapshot();
		return {
			activeCellId: current.activeCellId,
			queuedCellIds: [...current.queuedCellIds, ...this.#held.map((cell) => cell.input.cellId)],
		};
	}

	deliverToolReply(message: Extract<HostToKernelMessage, { type: "tool-reply" }>): void {
		this.#kernel.deliverToolReply(message);
	}

	async reset(): Promise<void> {
		if (this.#replacing !== null) await this.#replacing;
		if (this.#kernel.isAlive?.() === false) {
			// A reset discards every global anyway, so the fresh instance announces nothing.
			this.#unannounced = null;
			const replacing = this.#replace(null);
			this.#replacing = replacing;
			await replacing;
			if (this.#replacing === replacing) this.#replacing = null;
			return;
		}
		await this.#kernel.reset();
	}

	async close(): Promise<void> {
		this.#closed = true;
		const held = this.#held.splice(0);
		for (const cell of held)
			cell.settle(unstartedResult(cell.input.cellId, new ReplaceableKernelClosedError().message));
		if (this.#replacing !== null) await this.#replacing;
		if (this.#closeFailure !== undefined) throw this.#closeFailure;
		await this.#kernel.close();
	}

	listKernelToolNames(): readonly string[] {
		return this.#kernel.listKernelToolNames?.() ?? [];
	}

	#submit(generation: number, kernel: EvalKernel, input: EvalKernelRunInput): Promise<EvalKernelResult> {
		return kernel.run(input).then((result) => {
			if (generation !== this.#generation) return result;
			// The result the kernel settled for the cell its death interrupted proves nothing about the
			// replacement; a result from a still-live current instance proves it works.
			// A drained cell settles through this same promise already tagged; only the interrupted one is `lost`.
			if (kernel.isAlive?.() === false)
				return result.kernelState === undefined ? { ...result, kernelState: "lost" } : result;
			this.#recovering = null;
			const notice = this.#announce;
			if (notice === null) return result;
			this.#announce = null;
			return { ...result, notice, kernelState: "restarted" };
		});
	}

	#died(generation: number, reason: string): void {
		if (generation !== this.#generation || this.#closed) return;
		this.#held = [...(this.#kernel.drainPending?.() ?? []), ...this.#held];
		if (this.#recovering !== null) {
			this.#recovering = null;
			this.#unannounced = reason;
			const error = new KernelUnavailableError(this.#language, reason);
			for (const cell of this.#held.splice(0)) cell.settle(unstartedResult(cell.input.cellId, error.message));
			return;
		}
		this.#recovering = reason;
		this.#ensureReplacement();
	}

	#ensureReplacement(): void {
		if (this.#replacing !== null) return;
		const reason = this.#recovering ?? this.#unannounced;
		this.#recovering = reason;
		this.#unannounced = null;
		const replacing = this.#replace(reason).finally(() => {
			if (this.#replacing === replacing) this.#replacing = null;
		});
		this.#replacing = replacing;
	}

	/** Never rejects: every failure settles the held cells with what went wrong. */
	async #replace(reason: string | null): Promise<void> {
		const dead = this.#kernel;
		try {
			await dead.close();
		} catch (error) {
			// The old interpreter may still be running: report that rather than start a second one.
			this.#failUnavailable(reason, `its interpreter could not be retired: ${errorText(error)}`);
			return;
		}
		if (this.#closed) return;
		const generation = ++this.#nextGeneration;
		let next: EvalKernel;
		try {
			next = await this.#start({ onDeath: (died) => this.#died(generation, died) });
		} catch (error) {
			this.#failUnavailable(reason, `its replacement did not start: ${errorText(error)}`);
			return;
		}
		if (this.#closed) {
			await next.close().catch((error: unknown) => {
				this.#closeFailure = error;
			});
			return;
		}
		this.#kernel = next;
		this.#generation = generation;
		this.#announce = reason === null ? null : restartNotice(this.#language, reason);
		for (const cell of this.#held.splice(0)) {
			void this.#submit(generation, next, cell.input).then(cell.settle, (error: unknown) =>
				cell.settle(unstartedResult(cell.input.cellId, errorText(error))),
			);
		}
	}

	#failUnavailable(reason: string | null, detail: string): void {
		this.#recovering = null;
		this.#unannounced = reason;
		const error = new KernelUnavailableError(this.#language, reason === null ? detail : `${reason}; ${detail}`);
		for (const cell of this.#held.splice(0)) cell.settle(unstartedResult(cell.input.cellId, error.message));
	}

	#cancelHeld(cellId: string, reason: string): boolean {
		const index = this.#held.findIndex((cell) => cell.input.cellId === cellId);
		const [cell] = index < 0 ? [] : this.#held.splice(index, 1);
		cell?.settle(unstartedResult(cellId, reason));
		return cell !== undefined;
	}

	#failHeld(message: string): void {
		for (const cell of this.#held.splice(0)) cell.settle(unstartedResult(cell.input.cellId, message));
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
