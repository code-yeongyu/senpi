import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelToHostMessage } from "../../../src/bridge/protocol.ts";
import { SubprocessKernel } from "../../../src/kernels/shared/subprocess-kernel.ts";
import type { EvalKernel } from "../../../src/tool/types.ts";

class InterruptibleFakeProcess extends EventEmitter {
	readonly stdin = { writes: [] as string[], write: (chunk: string): number => this.stdin.writes.push(chunk) };
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly killedSignals: NodeJS.Signals[] = [];
	private readonly exitOnKill: boolean;

	constructor(exitOnKill = true) {
		super();
		this.exitOnKill = exitOnKill;
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killedSignals.push(signal);
		if (this.exitOnKill) queueMicrotask(() => this.emit("exit", null, signal));
		return true;
	}

	emitMessage(message: KernelToHostMessage): void {
		this.stdout.write(`${JSON.stringify(message)}\n`);
	}
}

afterEach(() => {
	vi.useRealTimers();
});

describe("SubprocessKernel interrupt", () => {
	it("interrupts the active cell and starts queued work after confirmed exit", async () => {
		const first = new InterruptibleFakeProcess();
		const second = new InterruptibleFakeProcess();
		const processes = [first, second];
		const kernel = createKernel(() => {
			const process = processes.shift();
			if (!process) throw new Error("unexpected subprocess spawn");
			return process;
		});
		const active = kernel.run({ cellId: "active-ruby-cell", code: "loop {}", timeoutMs: 30_000 });
		const queued = kernel.run({ cellId: "queued-ruby-cell", code: "40 + 2", timeoutMs: 2_000 });

		const evalKernel: EvalKernel = kernel;
		expect(evalKernel.interrupt).toBeTypeOf("function");
		await evalKernel.interrupt("manual stop");

		await expect(active).resolves.toMatchObject({
			ok: false,
			error: { message: "Eval interrupted: manual stop" },
		});
		const interruptSignal = process.platform === "win32" ? "SIGTERM" : "SIGINT";
		expect(first.killedSignals).toEqual([interruptSignal]);
		expect(second.stdin.writes).toHaveLength(2);
		second.emitMessage({ type: "result", cellId: "queued-ruby-cell", ok: true, valueRepr: "42", durationMs: 1 });
		await expect(queued).resolves.toMatchObject({ ok: true, valueRepr: "42" });
		await kernel.close();
	});

	it("fails closed after SIGKILL grace expires without confirmed exit", async () => {
		vi.useFakeTimers();
		const first = new InterruptibleFakeProcess(false);
		let spawnCount = 0;
		const kernel = createKernel(() => {
			spawnCount += 1;
			return first;
		});
		const active = kernel.run({ cellId: "stuck-ruby-cell", code: "loop {}", timeoutMs: 30_000 });
		const queued = kernel.run({ cellId: "queued-ruby-cell", code: "40 + 2", timeoutMs: 2_000 });

		const interrupted = kernel.interrupt("manual stop");
		await vi.advanceTimersByTimeAsync(5_500);
		await interrupted;

		expect(first.killedSignals).toEqual([process.platform === "win32" ? "SIGTERM" : "SIGINT", "SIGKILL"]);
		await expect(active).resolves.toMatchObject({ ok: false, error: { message: "Eval interrupted: manual stop" } });
		await expect(queued).resolves.toMatchObject({
			ok: false,
			error: { message: "Kernel process did not exit after SIGKILL" },
			durationMs: 0,
		});
		expect(spawnCount).toBe(1);
		expect(() => kernel.run({ cellId: "later", code: "3" })).toThrow("Kernel is closed");
		await kernel.close();
	});
});

function createKernel(spawn: () => InterruptibleFakeProcess): SubprocessKernel {
	return new SubprocessKernel({
		command: "ruby",
		args: ["runner.rb"],
		spawn,
		sessionId: "subprocess-interrupt",
		connection: { port: 39_001, token: "mock-token" },
	});
}
