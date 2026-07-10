import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelToHostMessage } from "../../../src/bridge/protocol.ts";
import {
	type KernelResult,
	SubprocessKernel,
	type SubprocessSpawn,
} from "../../../src/kernels/shared/subprocess-kernel.ts";

class RaceSubprocess extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly killedSignals: NodeJS.Signals[] = [];
	readonly stdin = { writes: [] as string[], write: (chunk: string): number => this.stdin.writes.push(chunk) };
	private readonly exitOnKill: boolean;

	constructor(exitOnKill = true) {
		super();
		this.exitOnKill = exitOnKill;
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killedSignals.push(signal);
		if (this.exitOnKill) this.exitNow(signal);
		return true;
	}

	exitNow(signal: NodeJS.Signals = "SIGTERM"): void {
		this.emit("exit", null, signal);
	}

	emitError(message: string): void {
		this.emit("error", new Error(message));
	}

	emitMessage(message: KernelToHostMessage): void {
		this.stdout.write(`${JSON.stringify(message)}\n`);
	}
}

afterEach(() => {
	vi.useRealTimers();
});

describe("SubprocessKernel settlement races", () => {
	it("lets a result win once over its later timeout", async () => {
		vi.useFakeTimers();
		const child = new RaceSubprocess();
		let spawnCount = 0;
		const kernel = createKernel(() => {
			spawnCount += 1;
			return child;
		});
		const settlements: KernelResult[] = [];
		const run = kernel.run({ cellId: "race", code: "fast", timeoutMs: 10 });
		void run.then((result) => settlements.push(result));

		child.emitMessage(success("race", "winner"));
		await vi.advanceTimersByTimeAsync(10);

		await expect(run).resolves.toMatchObject({ ok: true, valueRepr: "winner" });
		expect(settlements).toHaveLength(1);
		expect(spawnCount).toBe(1);
		await kernel.close();
	});

	it("lets timeout win once over a late result and concurrent exit", async () => {
		vi.useFakeTimers();
		const firstChild = new RaceSubprocess(false);
		const secondChild = new RaceSubprocess();
		const children = [firstChild, secondChild];
		const kernel = createKernel(spawnFrom(children));
		const settlements: KernelResult[] = [];
		const run = kernel.run({ cellId: "race", code: "slow", timeoutMs: 10 });
		void run.then((result) => settlements.push(result));

		await vi.advanceTimersByTimeAsync(10);
		firstChild.emitMessage(success("race", "late"));
		firstChild.exitNow();

		await expect(run).resolves.toMatchObject({ ok: false, durationMs: 10 });
		expect(settlements).toHaveLength(1);
		expect(children).toHaveLength(0);
		await kernel.close();
	});

	it("lets unexpected exit win once over timeout and late result", async () => {
		vi.useFakeTimers();
		const child = new RaceSubprocess(false);
		let spawnCount = 0;
		const kernel = createKernel(() => {
			spawnCount += 1;
			return child;
		});
		const settlements: KernelResult[] = [];
		const run = kernel.run({ cellId: "race", code: "crash", timeoutMs: 10 });
		void run.then((result) => settlements.push(result));

		child.exitNow("SIGABRT");
		child.emitMessage(success("race", "late"));
		await vi.advanceTimersByTimeAsync(10);

		await expect(run).resolves.toMatchObject({
			ok: false,
			error: { message: "Kernel exited before completing the cell (SIGABRT)" },
		});
		expect(settlements).toHaveLength(1);
		expect(spawnCount).toBe(1);
		expect(() => kernel.run({ cellId: "later", code: "3" })).toThrow("Kernel is closed");
	});

	it("lets interrupt win once over timeout and late result", async () => {
		vi.useFakeTimers();
		const firstChild = new RaceSubprocess(false);
		const secondChild = new RaceSubprocess();
		const children = [firstChild, secondChild];
		const kernel = createKernel(spawnFrom(children));
		const settlements: KernelResult[] = [];
		const run = kernel.run({ cellId: "race", code: "block", timeoutMs: 10 });
		void run.then((result) => settlements.push(result));

		await vi.advanceTimersByTimeAsync(9);
		const interrupt = kernel.interrupt("manual stop");
		await vi.advanceTimersByTimeAsync(1);
		firstChild.emitMessage(success("race", "late"));
		firstChild.exitNow();
		await interrupt;

		await expect(run).resolves.toMatchObject({ ok: false, error: { message: "Eval interrupted: manual stop" } });
		expect(settlements).toHaveLength(1);
		expect(children).toHaveLength(0);
		await kernel.close();
	});

	it("lets an active process error win once over timeout and late result", async () => {
		vi.useFakeTimers();
		const child = new RaceSubprocess();
		const kernel = createKernel(() => child);
		const settlements: KernelResult[] = [];
		const run = kernel.run({ cellId: "race", code: "error", timeoutMs: 10 });
		void run.then((result) => settlements.push(result));

		child.emitError("spawn channel failed");
		child.emitMessage(success("race", "late"));
		await vi.advanceTimersByTimeAsync(10);

		await expect(run).resolves.toMatchObject({
			ok: false,
			error: { message: "Kernel process error: spawn channel failed" },
		});
		expect(settlements).toHaveLength(1);
		expect(() => kernel.run({ cellId: "later", code: "3" })).toThrow("Kernel is closed");
		await kernel.close();
	});

	it("terminates an errored active child and lets close await its exit", async () => {
		const child = new RaceSubprocess(false);
		let spawnCount = 0;
		const kernel = createKernel(() => {
			spawnCount += 1;
			return child;
		});
		let activeSettlements = 0;
		let queuedSettlements = 0;
		const active = kernel.run({ cellId: "active", code: "block" });
		const queued = kernel.run({ cellId: "queued", code: "later" });
		void active.then(() => {
			activeSettlements += 1;
		});
		void queued.then(() => {
			queuedSettlements += 1;
		});

		child.emitError("spawn channel failed");

		await expect(Promise.all([active, queued])).resolves.toEqual([
			expect.objectContaining({ ok: false, error: { message: "Kernel process error: spawn channel failed" } }),
			expect.objectContaining({ ok: false, error: { message: "Kernel process error: spawn channel failed" } }),
		]);
		expect(activeSettlements).toBe(1);
		expect(queuedSettlements).toBe(1);
		expect(child.killedSignals).toEqual(["SIGTERM"]);
		expect(spawnCount).toBe(1);

		let closeSettled = false;
		const close = kernel.close().then(() => {
			closeSettled = true;
		});
		await Promise.resolve();
		expect(closeSettled).toBe(false);

		child.exitNow();
		await close;

		expect(closeSettled).toBe(true);
		expect(activeSettlements).toBe(1);
		expect(queuedSettlements).toBe(1);
		expect(spawnCount).toBe(1);
	});

	it("retains an errored child when forced termination cannot confirm exit", async () => {
		vi.useFakeTimers();
		const child = new RaceSubprocess(false);
		let spawnCount = 0;
		const kernel = createKernel(() => {
			spawnCount += 1;
			return child;
		});
		const retiredProcess = Reflect.get(kernel, "process");
		const run = kernel.run({ cellId: "active", code: "block" });

		child.emitError("spawn channel failed");
		const close = kernel.close();
		let closeSettled = false;
		void close.then(() => {
			closeSettled = true;
		});

		await expect(run).resolves.toMatchObject({
			ok: false,
			error: { message: "Kernel process error: spawn channel failed" },
		});
		expect(child.killedSignals).toEqual(["SIGTERM"]);
		expect(closeSettled).toBe(false);

		await vi.advanceTimersByTimeAsync(1_500);
		expect(child.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(closeSettled).toBe(false);

		await vi.advanceTimersByTimeAsync(500);
		await close;

		expect(closeSettled).toBe(true);
		expect(spawnCount).toBe(1);
		expect(Reflect.get(kernel, "process")).toBe(retiredProcess);
		expect(() => kernel.run({ cellId: "later", code: "3" })).toThrow("Kernel is closed");
	});
});

function createKernel(spawn: SubprocessSpawn): SubprocessKernel {
	return new SubprocessKernel({
		command: "ruby",
		args: ["runner.rb"],
		spawn,
		sessionId: "session-1",
		connection: { port: 39_001, token: "secret-token" },
	});
}

function spawnFrom(children: RaceSubprocess[]): SubprocessSpawn {
	return () => {
		const child = children.shift();
		if (!child) throw new Error("unexpected spawn");
		return child;
	};
}

function success(cellId: string, valueRepr: string): KernelResult {
	return { type: "result", cellId, ok: true, valueRepr, durationMs: 1 };
}
