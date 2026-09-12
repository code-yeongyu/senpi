import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelToHostMessage } from "../../../src/bridge/protocol.ts";
import { decodeBridgeFrame } from "../../../src/bridge/protocol.ts";
import type { SubprocessSpawn } from "../../../src/kernels/shared/subprocess-kernel.ts";
import { SubprocessKernel } from "../../../src/kernels/shared/subprocess-kernel.ts";

class FakeProc extends EventEmitter {
	readonly stdin: { readonly writes: string[]; readonly write: (chunk: string) => number };
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly killedSignals: NodeJS.Signals[] = [];

	constructor(writeError?: Error) {
		super();
		const writes: string[] = [];
		this.stdin = {
			writes,
			write: (chunk) => {
				if (writeError) throw writeError;
				return writes.push(chunk);
			},
		};
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killedSignals.push(signal);
		queueMicrotask(() => this.emit("exit", null, signal));
		return true;
	}

	emitMessage(message: KernelToHostMessage): void {
		this.stdout.write(`${JSON.stringify(message)}\n`);
	}
}

afterEach(() => {
	vi.useRealTimers();
});

describe("SubprocessKernel", () => {
	it("sends bridge init over stdin without leaking port or token into argv", async () => {
		const fake = new FakeProc();
		const spawnCalls: { readonly command: string; readonly args: readonly string[] }[] = [];
		const spawn: SubprocessSpawn = (command, args) => {
			spawnCalls.push({ command, args });
			return fake;
		};
		const kernel = new SubprocessKernel({
			command: "ruby",
			args: ["runner.rb"],
			spawn,
			sessionId: "session-1",
			connection: { port: 39_001, token: "secret-token" },
		});

		expect(spawnCalls).toEqual([{ command: "ruby", args: ["runner.rb"] }]);
		expect(spawnCalls[0]?.args.join(" ")).not.toContain("secret-token");
		expect(spawnCalls[0]?.args.join(" ")).not.toContain("39001");
		expect(JSON.parse(fake.stdin.writes[0] ?? "{}")).toEqual({
			type: "init",
			sessionId: "session-1",
			connection: { port: 39_001, token: "secret-token" },
		});

		await kernel.close();
	});

	it("retires an acquired child when the initial init write fails", async () => {
		const fake = new FakeProc(new Error("init write failed"));
		let startupError: unknown;

		try {
			new SubprocessKernel({
				command: "ruby",
				args: ["runner.rb"],
				spawn: () => fake,
				sessionId: "session-1",
				connection: { port: 39_001, token: "secret-token" },
			});
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			startupError = error;
		}

		expect(fake.killedSignals).toEqual(["SIGTERM"]);
		expect(startupError).toMatchObject({
			name: "KernelStartupError",
			message: "Kernel startup failed: init write failed",
		});
	});

	it("waits for the exact ready signal before starting a cell timeout", async () => {
		vi.useFakeTimers();
		const fake = new FakeProc();
		const kernel = new SubprocessKernel({
			command: "ruby",
			args: ["runner.rb"],
			spawn: () => fake,
			sessionId: "session-1",
			connection: { port: 39_001, token: "secret-token" },
		});
		const run = kernel.run({ cellId: "after-ready", code: "42", timeoutMs: 10 });
		const settlements: KernelToHostMessage[] = [];
		void run.then((result) => settlements.push(result));

		await vi.advanceTimersByTimeAsync(100);
		expect(fake.stdin.writes).toHaveLength(1);
		expect(settlements).toEqual([]);

		fake.emitMessage({ type: "ready" });
		await vi.advanceTimersByTimeAsync(0);
		expect(decodeBridgeFrame(fake.stdin.writes[1] ?? "")).toMatchObject({
			ok: true,
			message: { type: "run", cellId: "after-ready", code: "42", timeoutMs: 10 },
		});
		fake.emitMessage({ type: "result", cellId: "after-ready", ok: true, valueRepr: "42", durationMs: 1 });

		await expect(run).resolves.toMatchObject({ ok: true, valueRepr: "42" });
		await kernel.close();
	});

	it("fails queued work immediately when initialization fails", async () => {
		const fake = new FakeProc();
		const kernel = new SubprocessKernel({
			command: "ruby",
			args: ["runner.rb"],
			spawn: () => fake,
			sessionId: "session-1",
			connection: { port: 39_001, token: "secret-token" },
		});
		const run = kernel.run({ cellId: "never-started", code: "42", timeoutMs: 1_000 });

		fake.emitMessage({ type: "init-failed", error: { message: "prelude failed" } });

		await expect(run).resolves.toMatchObject({
			ok: false,
			error: { message: "Kernel startup failed: prelude failed" },
			durationMs: 0,
		});
		await kernel.close();
	});

	it("runs cells and round-trips tool replies", async () => {
		const fake = new FakeProc();
		const messages: KernelToHostMessage[] = [];
		const kernel = createKernel(
			() => fake,
			(message) => messages.push(message),
		);

		const run = kernel.run({ cellId: "cell-1", code: "tool.read(path: 'x')", timeoutMs: 1_000 });
		fake.emitMessage({ type: "tool-call", callId: "call-1", toolName: "read", args: { path: "x" } });
		const call = await kernel.nextToolCall();
		expect(call.toolName).toBe("read");

		kernel.deliverToolReply({ type: "tool-reply", callId: "call-1", ok: true, value: "from-host" });
		expect(decodeBridgeFrame(fake.stdin.writes.at(-1) ?? "")).toMatchObject({
			ok: true,
			message: { type: "tool-reply", callId: "call-1", ok: true, value: "from-host" },
		});

		fake.emitMessage({ type: "result", cellId: "cell-1", ok: true, valueRepr: '"from-host"', durationMs: 4 });
		await expect(run).resolves.toMatchObject({ ok: true, valueRepr: '"from-host"' });
		expect(messages).toContainEqual({ type: "tool-call", callId: "call-1", toolName: "read", args: { path: "x" } });
		await kernel.close();
	});

	it("reset respawns the subprocess and re-sends init", async () => {
		const first = new FakeProc();
		const second = new FakeProc();
		const processes = [first, second];
		const kernel = createKernel(() => {
			const process = processes.shift();
			if (!process) throw new Error("unexpected spawn");
			return process;
		});

		await kernel.reset();

		expect(first.killedSignals).toEqual(["SIGTERM"]);
		expect(processes).toHaveLength(0);
		expect(decodeBridgeFrame(second.stdin.writes[0] ?? "")).toMatchObject({
			ok: true,
			message: { type: "init", sessionId: "session-1" },
		});
		await kernel.close();
	});
});

function createKernel(spawn: SubprocessSpawn, onMessage?: (message: KernelToHostMessage) => void): SubprocessKernel {
	let initial: FakeProc | undefined;
	const readySpawn: SubprocessSpawn = (command, args, options) => {
		const child = spawn(command, args, options);
		if (!(child instanceof FakeProc)) throw new Error("expected FakeProc");
		if (!initial) initial = child;
		else queueMicrotask(() => child.emitMessage({ type: "ready" }));
		return child;
	};
	const kernel = new SubprocessKernel({
		command: "ruby",
		args: ["runner.rb"],
		spawn: readySpawn,
		sessionId: "session-1",
		connection: { port: 39_001, token: "secret-token" },
		onMessage,
	});
	initial?.emitMessage({ type: "ready" });
	return kernel;
}
