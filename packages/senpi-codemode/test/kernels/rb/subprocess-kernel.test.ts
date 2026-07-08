import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../../../src/bridge/protocol.ts";
import { decodeBridgeFrame } from "../../../src/bridge/protocol.ts";
import type { SubprocessSpawn } from "../../../src/kernels/shared/subprocess-kernel.ts";
import { SubprocessKernel } from "../../../src/kernels/shared/subprocess-kernel.ts";

class FakeProc extends EventEmitter {
	readonly stdin = { writes: [] as string[], write: (chunk: string) => this.stdin.writes.push(chunk) };
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly killedSignals: string[] = [];

	kill(signal?: NodeJS.Signals): boolean {
		this.killedSignals.push(signal ?? "SIGTERM");
		setImmediate(() => this.emit("exit", null, signal ?? "SIGTERM"));
		return true;
	}
}

class FakePersistentRuntime extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly killedSignals: string[] = [];
	private readonly timers: NodeJS.Timeout[] = [];
	private state: number | undefined;

	readonly stdin = {
		writes: [] as string[],
		write: (chunk: string) => {
			this.stdin.writes.push(chunk);
			const decoded = decodeBridgeFrame(chunk);
			if (!decoded.ok) return;
			if (decoded.message.type !== "run") return;
			const message = decoded.message;
			if (message.code === "sleep-then-mutate") {
				this.timers.push(
					setTimeout(() => {
						this.state = 99;
						this.stdout.write(
							`${JSON.stringify({ type: "result", cellId: message.cellId, ok: true, durationMs: 30 })}\n`,
						);
					}, 30),
				);
				return;
			}
			if (message.code === "read-state") {
				setImmediate(() => {
					this.stdout.write(
						`${JSON.stringify({
							type: "result",
							cellId: message.cellId,
							ok: true,
							valueRepr: this.state === undefined ? "nil" : String(this.state),
							durationMs: 1,
						})}\n`,
					);
				});
			}
		},
	};

	kill(signal?: NodeJS.Signals): boolean {
		this.killedSignals.push(signal ?? "SIGTERM");
		for (const timer of this.timers) clearTimeout(timer);
		this.emit("exit", null, signal ?? "SIGTERM");
		return true;
	}
}

class FakeDelayedExitRuntime extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly killedSignals: string[] = [];
	readonly stdin = {
		writes: [] as string[],
		write: (chunk: string) => {
			this.stdin.writes.push(chunk);
		},
	};

	kill(signal?: NodeJS.Signals): boolean {
		this.killedSignals.push(signal ?? "SIGTERM");
		return true;
	}

	exitNow(signal: NodeJS.Signals = "SIGTERM"): void {
		this.emit("exit", null, signal);
	}
}

describe("SubprocessKernel", () => {
	it("sends bridge init over stdin without leaking port or token into argv", async () => {
		const fake = new FakeProc();
		const spawnCalls: { command: string; args: readonly string[] }[] = [];
		const spawn: SubprocessSpawn = (command, args) => {
			spawnCalls.push({ command, args });
			return fake;
		};

		const kernel = new SubprocessKernel({
			command: "ruby",
			args: ["runner.rb"],
			spawn,
			sessionId: "session-1",
			connection: { port: 39001, token: "secret-token" },
		});

		expect(spawnCalls).toEqual([{ command: "ruby", args: ["runner.rb"] }]);
		expect(spawnCalls[0]?.args.join(" ")).not.toContain("secret-token");
		expect(spawnCalls[0]?.args.join(" ")).not.toContain("39001");
		expect(JSON.parse(fake.stdin.writes[0] ?? "{}")).toEqual({
			type: "init",
			sessionId: "session-1",
			connection: { port: 39001, token: "secret-token" },
		});

		await kernel.close();
	});

	it("runs queued cells and round-trips tool replies", async () => {
		const fake = new FakeProc();
		const messages: KernelToHostMessage[] = [];
		const kernel = new SubprocessKernel({
			command: "ruby",
			args: ["runner.rb"],
			spawn: () => fake,
			sessionId: "session-1",
			connection: { port: 39001, token: "secret-token" },
			onMessage: (message) => messages.push(message),
		});

		const run = kernel.run({ cellId: "cell-1", code: "tool.read(path: 'x')", timeoutMs: 1_000 });
		fake.stdout.write(
			`${JSON.stringify({ type: "tool-call", callId: "call-1", toolName: "read", args: { path: "x" } })}\n`,
		);
		const call = await kernel.nextToolCall();
		expect(call.toolName).toBe("read");

		kernel.deliverToolReply({ type: "tool-reply", callId: "call-1", ok: true, value: "from-host" });
		expect(JSON.parse(fake.stdin.writes.at(-1) ?? "{}")).toEqual({
			type: "tool-reply",
			callId: "call-1",
			ok: true,
			value: "from-host",
		});

		fake.stdout.write(
			`${JSON.stringify({ type: "result", cellId: "cell-1", ok: true, valueRepr: '"from-host"', durationMs: 4 })}\n`,
		);
		await expect(run).resolves.toMatchObject({ ok: true, valueRepr: '"from-host"' });
		expect(messages).toContainEqual({ type: "tool-call", callId: "call-1", toolName: "read", args: { path: "x" } });

		await kernel.close();
	});

	it("reset respawns the subprocess and re-sends init over stdin", async () => {
		const first = new FakeProc();
		const second = new FakeProc();
		const procs = [first, second];
		const kernel = new SubprocessKernel({
			command: "ruby",
			args: ["runner.rb"],
			spawn: () => {
				const proc = procs.shift();
				if (!proc) throw new Error("unexpected spawn");
				return proc;
			},
			sessionId: "session-1",
			connection: { port: 39001, token: "secret-token" },
		});

		await kernel.reset();

		expect(procs).toHaveLength(0);
		expect(first.killedSignals).toEqual(["SIGTERM"]);
		expect(second.stdin.writes).toHaveLength(1);
		expect(JSON.parse(second.stdin.writes[0] ?? "{}")).toMatchObject({ type: "init", sessionId: "session-1" });
		await kernel.close();
	});

	it("kills timed-out work before it can mutate future persistent state", async () => {
		const first = new FakePersistentRuntime();
		const second = new FakePersistentRuntime();
		const procs = [first, second];
		const kernel = new SubprocessKernel({
			command: "ruby",
			args: ["runner.rb"],
			spawn: () => {
				const proc = procs.shift();
				if (!proc) throw new Error("unexpected spawn");
				return proc;
			},
			sessionId: "session-1",
			connection: { port: 39001, token: "secret-token" },
		});

		const timedOut = await kernel.run({ cellId: "timeout", code: "sleep-then-mutate", timeoutMs: 5 });
		expect(timedOut).toMatchObject({
			ok: false,
			error: { message: "Cell timed out after 5ms" },
		});
		expect(first.killedSignals).toEqual(["SIGTERM"]);

		await new Promise((resolve) => setTimeout(resolve, 40));
		const afterTimeout = await kernel.run({ cellId: "after-timeout", code: "read-state", timeoutMs: 1_000 });

		expect(afterTimeout).toMatchObject({ ok: true, valueRepr: "nil" });
		expect(procs).toHaveLength(0);
		await kernel.close();
	});

	it("waits for timed-out and restarted subprocesses to exit before close resolves", async () => {
		const first = new FakeDelayedExitRuntime();
		const second = new FakeDelayedExitRuntime();
		const procs = [first, second];
		const kernel = new SubprocessKernel({
			command: "ruby",
			args: ["runner.rb"],
			spawn: () => {
				const proc = procs.shift();
				if (!proc) throw new Error("unexpected spawn");
				return proc;
			},
			sessionId: "session-1",
			connection: { port: 39001, token: "secret-token" },
		});

		await kernel.run({ cellId: "timeout", code: "sleep-then-mutate", timeoutMs: 5 });
		let closed = false;
		const closePromise = kernel.close().then(() => {
			closed = true;
		});

		await new Promise((resolve) => setImmediate(resolve));

		expect(closed).toBe(false);
		expect(first.killedSignals).toEqual(["SIGTERM"]);
		expect(second.killedSignals).toEqual(["SIGTERM"]);
		first.exitNow();
		await new Promise((resolve) => setImmediate(resolve));
		expect(closed).toBe(false);
		second.exitNow();
		await closePromise;
		expect(closed).toBe(true);
	});
});
