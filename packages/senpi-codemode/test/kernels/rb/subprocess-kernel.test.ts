import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../../../src/bridge/protocol.ts";
import { decodeBridgeFrame } from "../../../src/bridge/protocol.ts";
import type { SubprocessSpawn } from "../../../src/kernels/shared/subprocess-kernel.ts";
import { SubprocessKernel } from "../../../src/kernels/shared/subprocess-kernel.ts";

class FakeProc extends EventEmitter {
	readonly stdin = { writes: [] as string[], write: (chunk: string): number => this.stdin.writes.push(chunk) };
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly killedSignals: NodeJS.Signals[] = [];

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killedSignals.push(signal);
		queueMicrotask(() => this.emit("exit", null, signal));
		return true;
	}

	emitMessage(message: KernelToHostMessage): void {
		this.stdout.write(`${JSON.stringify(message)}\n`);
	}
}

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
	return new SubprocessKernel({
		command: "ruby",
		args: ["runner.rb"],
		spawn,
		sessionId: "session-1",
		connection: { port: 39_001, token: "secret-token" },
		onMessage,
	});
}
