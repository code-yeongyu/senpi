import { describe, expect, it } from "vitest";
import { ReplaceableKernel, type StartKernel } from "../src/extension/kernel-replacement.ts";
import type {
	EvalKernel,
	EvalKernelResult,
	EvalKernelRunInput,
	KernelInterruptHandle,
	PendingCell,
} from "../src/tool/types.ts";

class MortalKernel implements EvalKernel {
	readonly ran: string[] = [];
	readonly #queue: PendingCell[] = [];
	#active: PendingCell | null = null;
	#alive = true;
	#closeFailure: Error | undefined;
	readonly #onDeath: (reason: string) => void;

	constructor(onDeath: (reason: string) => void, closeFailure?: Error) {
		this.#onDeath = onDeath;
		this.#closeFailure = closeFailure;
	}

	run(input: EvalKernelRunInput): Promise<EvalKernelResult> {
		return new Promise((settle) => {
			this.#queue.push({ input, settle });
			this.#pump();
		});
	}

	finishActive(valueRepr: string): void {
		const active = this.#active;
		if (!active) throw new Error("no active cell");
		this.#active = null;
		active.settle({ type: "result", cellId: active.input.cellId, ok: true, valueRepr, durationMs: 1 });
		this.#pump();
	}

	die(reason = "signal 9"): void {
		this.#alive = false;
		const active = this.#active;
		this.#active = null;
		active?.settle({
			type: "result",
			cellId: active.input.cellId,
			ok: false,
			error: { message: "died" },
			durationMs: 1,
		});
		this.#onDeath(reason);
	}

	isAlive(): boolean {
		return this.#alive;
	}

	drainPending(): readonly PendingCell[] {
		return this.#queue.splice(0);
	}

	cancelQueued(cellId: string): boolean {
		const index = this.#queue.findIndex((cell) => cell.input.cellId === cellId);
		return index >= 0 && this.#queue.splice(index, 1).length === 1;
	}

	async interrupt(): Promise<KernelInterruptHandle> {
		return { stateRetained: Promise.resolve(true) };
	}

	queueSnapshot() {
		return {
			activeCellId: this.#active?.input.cellId ?? null,
			queuedCellIds: this.#queue.map((cell) => cell.input.cellId),
		};
	}

	deliverToolReply(): void {}

	async reset(): Promise<void> {}

	async close(): Promise<void> {
		if (this.#closeFailure) throw this.#closeFailure;
	}

	#pump(): void {
		if (this.#active || !this.#alive) return;
		const next = this.#queue.shift();
		if (!next) return;
		this.#active = next;
		this.ran.push(next.input.cellId);
		next.input.onStarted?.();
	}
}

interface Fleet {
	readonly instances: MortalKernel[];
	readonly start: StartKernel;
	gate?: Promise<void>;
	startFailure?: Error;
	closeFailure?: Error;
}

function fleet(): Fleet {
	const state: Fleet = {
		instances: [],
		start: async (lifecycle) => {
			await state.gate;
			if (state.startFailure) throw state.startFailure;
			const kernel = new MortalKernel(lifecycle.onDeath, state.closeFailure);
			state.instances.push(kernel);
			return kernel;
		},
	};
	return state;
}

const instance = (kernels: Fleet, index: number): MortalKernel => {
	const kernel = kernels.instances[index];
	if (!kernel) throw new Error(`no instance ${index}`);
	return kernel;
};

describe("a replaceable kernel", () => {
	it("Given five cells submitted while a dead kernel's replacement is still starting when it becomes ready then exactly one replacement spawned and all five ran on it in order", async () => {
		const kernels = fleet();
		const kernel = await ReplaceableKernel.create("py", kernels.start);
		const opening = Promise.withResolvers<void>();
		kernels.gate = opening.promise;

		instance(kernels, 0).die();
		const cells = ["a", "b", "c", "d", "e"].map((cellId) => kernel.run({ cellId, code: "" }));
		opening.resolve();

		await expect.poll(() => instance(kernels, 1).ran).toEqual(["a"]);
		for (const _cell of cells) instance(kernels, 1).finishActive("ok");
		const results = await Promise.all(cells);

		expect(kernels.instances).toHaveLength(2);
		expect(instance(kernels, 1).ran).toEqual(["a", "b", "c", "d", "e"]);
		expect(results.map((result) => result.ok)).toEqual([true, true, true, true, true]);
		expect(results.filter((result) => result.kernelState === "restarted")).toHaveLength(1);
	});

	it("Given cells submitted after a death whose replacement failed to start when the next replacement starts then they share one spawn", async () => {
		const kernels = fleet();
		const kernel = await ReplaceableKernel.create("jl", kernels.start);
		kernels.startFailure = new Error("interpreter missing");
		instance(kernels, 0).die();
		await expect(kernel.run({ cellId: "lost", code: "" })).resolves.toMatchObject({ ok: false });

		kernels.startFailure = undefined;
		const opening = Promise.withResolvers<void>();
		kernels.gate = opening.promise;
		const cells = ["x", "y", "z"].map((cellId) => kernel.run({ cellId, code: "" }));
		opening.resolve();
		await expect.poll(() => kernels.instances.length).toBe(2);
		for (const _cell of cells) instance(kernels, 1).finishActive("ok");
		await Promise.all(cells);

		expect(kernels.instances).toHaveLength(2);
		expect(instance(kernels, 1).ran).toEqual(["x", "y", "z"]);
	});

	it("never submits a queued cell cancelled while the replacement starts", async () => {
		const kernels = fleet();
		const kernel = await ReplaceableKernel.create("rb", kernels.start);
		const first = instance(kernels, 0);
		const opening = Promise.withResolvers<void>();
		kernels.gate = opening.promise;
		const running = kernel.run({ cellId: "running", code: "" });
		const cancelled = kernel.run({ cellId: "cancelled", code: "" });
		const kept = kernel.run({ cellId: "kept", code: "" });

		first.die();
		expect(kernel.cancelQueued("cancelled", "caller cancelled")).toBe(true);
		opening.resolve();

		await expect(cancelled).resolves.toMatchObject({ ok: false, error: { message: "caller cancelled" } });
		await expect(running).resolves.toMatchObject({ ok: false });
		await expect.poll(() => kernels.instances.length).toBe(2);
		await expect.poll(() => instance(kernels, 1).ran).toEqual(["kept"]);
		instance(kernels, 1).finishActive("ok");
		await expect(kept).resolves.toMatchObject({
			ok: true,
			notice: "[rb kernel was restarted after signal 9; every global is lost]",
		});
	});

	it("lets session disposal win over a replacement still starting", async () => {
		const kernels = fleet();
		const kernel = await ReplaceableKernel.create("py", kernels.start);
		const opening = Promise.withResolvers<void>();
		kernels.gate = opening.promise;
		kernel.run({ cellId: "running", code: "" });
		const queued = kernel.run({ cellId: "queued", code: "" });

		instance(kernels, 0).die();
		const closing = kernel.close();
		opening.resolve();
		await closing;

		await expect(queued).resolves.toMatchObject({ ok: false, error: { message: "Kernel closed" } });
		expect(kernels.instances.every((started) => started.ran.every((cellId) => cellId === "running"))).toBe(true);
		await expect(kernel.run({ cellId: "late", code: "" })).rejects.toThrow("Kernel closed");
	});

	it("fails the held cells with eval_kernel_unavailable when the replacement cannot start", async () => {
		const kernels = fleet();
		const kernel = await ReplaceableKernel.create("jl", kernels.start);
		kernel.run({ cellId: "running", code: "" });
		const queued = kernel.run({ cellId: "queued", code: "" });
		kernels.startFailure = new Error("no julia today");

		instance(kernels, 0).die("exit code 1");

		await expect(queued).resolves.toMatchObject({
			ok: false,
			error: { message: expect.stringMatching(/^eval_kernel_unavailable: .*exit code 1.*no julia today/) },
		});
		kernels.startFailure = undefined;
		const later = kernel.run({ cellId: "later", code: "" });
		await expect.poll(() => kernels.instances.length).toBe(2);
		instance(kernels, 1).finishActive("back");
		await expect(later).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("exit code 1") });
	});

	it("does not start a second interpreter while the dead one cannot be retired", async () => {
		const kernels = fleet();
		kernels.closeFailure = new Error("did not exit after SIGKILL");
		const kernel = await ReplaceableKernel.create("rb", kernels.start);
		kernel.run({ cellId: "running", code: "" });
		const queued = kernel.run({ cellId: "queued", code: "" });

		instance(kernels, 0).die();

		await expect(queued).resolves.toMatchObject({
			ok: false,
			error: { message: expect.stringContaining("could not be retired: did not exit after SIGKILL") },
		});
		expect(kernels.instances).toHaveLength(1);
	});

	it("ignores a late death reported by an instance it already replaced", async () => {
		const kernels = fleet();
		const kernel = await ReplaceableKernel.create("py", kernels.start);
		const first = instance(kernels, 0);
		first.die();
		const next = kernel.run({ cellId: "next", code: "" });
		await expect.poll(() => kernels.instances.length).toBe(2);

		first.die();
		instance(kernels, 1).finishActive("2");

		await expect(next).resolves.toMatchObject({ ok: true, valueRepr: "2" });
		expect(kernels.instances).toHaveLength(2);
	});
});
