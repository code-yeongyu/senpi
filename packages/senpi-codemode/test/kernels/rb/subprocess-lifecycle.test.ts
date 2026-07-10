import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostToKernelMessage, KernelToHostMessage } from "../../../src/bridge/protocol.ts";
import { decodeBridgeFrame } from "../../../src/bridge/protocol.ts";
import {
	type KernelResult,
	SubprocessKernel,
	type SubprocessSpawn,
} from "../../../src/kernels/shared/subprocess-kernel.ts";

class FakeSubprocess extends EventEmitter {
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

	hostMessages(): HostToKernelMessage[] {
		const messages: HostToKernelMessage[] = [];
		for (const write of this.stdin.writes) {
			const decoded = decodeBridgeFrame(write);
			if (decoded.ok && isHostMessage(decoded.message)) messages.push(decoded.message);
		}
		return messages;
	}
}

class ReplacementSpawnError extends Error {}

afterEach(() => {
	vi.useRealTimers();
});

describe("SubprocessKernel lifecycle", () => {
	it("starts queued duration when the queued run actually starts", async () => {
		vi.useFakeTimers();
		const firstChild = new FakeSubprocess();
		const replacement = new FakeSubprocess();
		const children = [firstChild, replacement];
		const kernel = createKernel(spawnFrom(children));
		const first = kernel.run({ cellId: "first", code: "1", timeoutMs: 1_000 });
		const second = kernel.run({ cellId: "second", code: "2", timeoutMs: 1_000 });
		const secondSettlements: KernelResult[] = [];
		void second.then((result) => secondSettlements.push(result));

		await vi.advanceTimersByTimeAsync(100);
		expect(runCellIds(firstChild)).toEqual(["first"]);
		expect(secondSettlements).toEqual([]);
		firstChild.emitMessage(success("first", "1"));
		await expect(first).resolves.toMatchObject({ ok: true, valueRepr: "1" });
		expect(runCellIds(firstChild)).toEqual(["first", "second"]);
		await vi.advanceTimersByTimeAsync(7);

		await kernel.reset();

		await expect(second).resolves.toMatchObject({ ok: false, error: { message: "Kernel reset" }, durationMs: 7 });
		expect(secondSettlements).toHaveLength(1);
		await kernel.close();
	});

	it("replaces a generation only after its exit is confirmed", async () => {
		const firstChild = new FakeSubprocess(false);
		const secondChild = new FakeSubprocess();
		const children = [firstChild, secondChild];
		const kernel = createKernel(spawnFrom(children));
		const interruptedRun = kernel.run({ cellId: "interrupt", code: "block", timeoutMs: 1_000 });
		const queuedRun = kernel.run({ cellId: "queued", code: "next", timeoutMs: 1_000 });

		const interrupt = kernel.interrupt("cancelled by caller");

		await expect(interruptedRun).resolves.toMatchObject({ ok: false });
		expect(children).toHaveLength(1);
		expect(runCellIds(firstChild)).toEqual(["interrupt"]);
		firstChild.exitNow();
		await interrupt;
		expect(children).toHaveLength(0);
		expect(runCellIds(secondChild)).toEqual(["queued"]);
		secondChild.emitMessage(success("queued", "next"));
		await expect(queuedRun).resolves.toMatchObject({ ok: true, valueRepr: "next" });
		await kernel.close();
	});

	it("fails closed without spawning when SIGKILL has no confirmed exit", async () => {
		vi.useFakeTimers();
		const child = new FakeSubprocess(false);
		let spawnCount = 0;
		const kernel = createKernel(() => {
			spawnCount += 1;
			return child;
		});
		const timedOut = kernel.run({ cellId: "timeout", code: "block", timeoutMs: 10 });
		const queued = kernel.run({ cellId: "queued", code: "never-started", timeoutMs: 10 });

		await vi.advanceTimersByTimeAsync(2_010);

		await expect(timedOut).resolves.toMatchObject({ ok: false, durationMs: 10 });
		await expect(queued).resolves.toMatchObject({
			ok: false,
			error: { message: "Kernel process did not exit after SIGKILL" },
			durationMs: 0,
		});
		expect(child.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(spawnCount).toBe(1);
		expect(() => kernel.run({ cellId: "later", code: "3" })).toThrow("Kernel is closed");
	});

	it("does not spawn a replacement when close begins during retirement", async () => {
		vi.useFakeTimers();
		const firstChild = new FakeSubprocess(false);
		const secondChild = new FakeSubprocess();
		const children = [firstChild, secondChild];
		const kernel = createKernel(spawnFrom(children));
		const timedOut = kernel.run({ cellId: "timeout", code: "block", timeoutMs: 10 });

		await vi.advanceTimersByTimeAsync(10);
		await expect(timedOut).resolves.toMatchObject({ ok: false, durationMs: 10 });
		const closing = kernel.close();
		expect(children).toEqual([secondChild]);

		firstChild.exitNow();
		await closing;

		expect(children).toEqual([secondChild]);
	});

	it("drops output calls results errors and exit from a retiring generation", async () => {
		const firstChild = new FakeSubprocess(false);
		const secondChild = new FakeSubprocess();
		const children = [firstChild, secondChild];
		const observed: KernelToHostMessage[] = [];
		const kernel = createKernel(spawnFrom(children), (message) => observed.push(message));
		const firstRun = kernel.run({ cellId: "first", code: "block", timeoutMs: 1_000 });
		const laterRun = kernel.run({ cellId: "later", code: "next", timeoutMs: 1_000 });

		const interrupt = kernel.interrupt("retire generation");
		firstChild.emitMessage({ type: "text", stream: "stdout", data: "late stdout" });
		firstChild.stderr.write("late stderr");
		firstChild.emitMessage({ type: "tool-call", callId: "late", toolName: "echo", args: {} });
		firstChild.emitMessage(success("later", "stale result"));
		firstChild.emitError("stale process error");

		await expect(firstRun).resolves.toMatchObject({ ok: false });
		expect(observed).toEqual([]);
		expect(children).toHaveLength(1);
		firstChild.exitNow();
		await interrupt;
		secondChild.emitMessage({ type: "text", stream: "stdout", data: "fresh stdout" });
		secondChild.emitMessage(success("later", "fresh result"));
		await expect(laterRun).resolves.toMatchObject({ ok: true, valueRepr: "fresh result" });
		expect(observed).toEqual([
			{ type: "text", stream: "stdout", data: "fresh stdout" },
			success("later", "fresh result"),
		]);
		await kernel.close();
	});

	it("settles queued work once when replacement startup fails", async () => {
		vi.useFakeTimers();
		const firstChild = new FakeSubprocess(false);
		let spawnCount = 0;
		const spawn: SubprocessSpawn = () => {
			spawnCount += 1;
			if (spawnCount === 1) return firstChild;
			throw new ReplacementSpawnError("replacement boom");
		};
		const kernel = createKernel(spawn);
		const timedOut = kernel.run({ cellId: "timeout", code: "block", timeoutMs: 10 });
		const queuedRuns = [
			kernel.run({ cellId: "queued-1", code: "one", timeoutMs: 50 }),
			kernel.run({ cellId: "queued-2", code: "two", timeoutMs: 50 }),
		];
		const settlements: KernelResult[] = [];
		for (const queued of queuedRuns) void queued.then((result) => settlements.push(result));

		await vi.advanceTimersByTimeAsync(10);
		firstChild.exitNow();

		await expect(timedOut).resolves.toMatchObject({ ok: false, durationMs: 10 });
		for (const queued of queuedRuns) {
			await expect(queued).resolves.toMatchObject({
				ok: false,
				error: { message: "Kernel startup failed: replacement boom" },
				durationMs: 0,
			});
		}
		expect(settlements).toHaveLength(2);
		expect(runCellIds(firstChild)).toEqual(["timeout"]);
		expect(spawnCount).toBe(2);
		expect(() => kernel.run({ cellId: "later", code: "3" })).toThrow("Kernel is closed");
	});
});

function createKernel(spawn: SubprocessSpawn, onMessage?: (message: KernelToHostMessage) => void): SubprocessKernel {
	return new SubprocessKernel({
		command: "ruby",
		args: ["runner.rb"],
		spawn,
		sessionId: "session-1",
		connection: { port: 39_001, token: "secret-token" },
		onMessage,
	});
}

function spawnFrom(children: FakeSubprocess[]): SubprocessSpawn {
	return () => {
		const child = children.shift();
		if (!child) throw new ReplacementSpawnError("unexpected spawn");
		return child;
	};
}

function runCellIds(child: FakeSubprocess): string[] {
	return child
		.hostMessages()
		.filter((message): message is Extract<HostToKernelMessage, { type: "run" }> => message.type === "run")
		.map((message) => message.cellId);
}

function success(cellId: string, valueRepr: string): KernelResult {
	return { type: "result", cellId, ok: true, valueRepr, durationMs: 1 };
}

function isHostMessage(message: HostToKernelMessage | KernelToHostMessage): message is HostToKernelMessage {
	return ["init", "run", "tool-reply", "interrupt", "close"].includes(message.type);
}
