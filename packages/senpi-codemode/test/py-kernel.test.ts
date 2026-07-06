import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { BridgeConnectionConfig, KernelToHostMessage } from "../src/bridge/protocol.ts";
import { decodeBridgeFrame, encodeBridgeFrame } from "../src/bridge/protocol.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { type KernelChild, type KernelSpawnOptions, PythonKernel } from "../src/kernels/py/kernel.ts";

class FakeChild implements KernelChild {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid = 12345;
	killed = false;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;

	constructor(autoRespond = true) {
		if (!autoRespond) return;
		this.stdin.on("data", (chunk) => {
			const lines = String(chunk).split("\n").filter(Boolean);
			for (const line of lines) {
				const decoded = decodeBridgeFrame(`${line}\n`);
				if (!decoded.ok) continue;
				if (decoded.message.type === "init") this.emitMessage({ type: "ready" });
				if (decoded.message.type === "run") {
					this.emitMessage({
						type: "result",
						cellId: decoded.message.cellId,
						ok: true,
						valueRepr: "fake",
						durationMs: 1,
					});
				}
				if (decoded.message.type === "close") {
					this.emitMessage({ type: "closed" });
					this.finish(0, null);
				}
			}
		});
	}

	kill(signal?: NodeJS.Signals): boolean {
		this.killed = true;
		this.finish(null, signal ?? "SIGTERM");
		return true;
	}

	emitMessage(message: KernelToHostMessage): void {
		this.stdout.write(encodeBridgeFrame(message));
	}

	finish(code: number | null, signal: NodeJS.Signals | null): void {
		this.exitCode = code;
		this.signalCode = signal;
		this.stdout.end();
		this.stderr.end();
		this.stdin.end();
		this.stdout.emit("close");
		this.stderr.emit("close");
		this.emit("exit", code, signal);
	}

	readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

	on(event: string, listener: (...args: unknown[]) => void): this {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		return this;
	}

	once(event: string, listener: (...args: unknown[]) => void): this {
		const wrapped = (...args: unknown[]) => {
			this.off(event, wrapped);
			listener(...args);
		};
		return this.on(event, wrapped);
	}

	off(event: string, listener: (...args: unknown[]) => void): this {
		this.listeners.set(
			event,
			(this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
		);
		return this;
	}

	emit(event: string, ...args: unknown[]): boolean {
		for (const listener of this.listeners.get(event) ?? []) listener(...args);
		return true;
	}
}

async function hasPython3(): Promise<boolean> {
	const detector = createInterpreterDetector();
	return (await detector.detect("py")).ok;
}

async function liveKernel(): Promise<PythonKernel> {
	const detector = createInterpreterDetector();
	const detected = await detector.detect("py");
	if (!detected.ok) throw new Error("python unavailable");
	return await PythonKernel.start({
		interpreterPath: detected.path,
		sessionId: "live-session",
		cwd: process.cwd(),
		connection: { port: 1, token: "unused" },
	});
}

async function runCell(kernel: PythonKernel, code: string): Promise<Extract<KernelToHostMessage, { type: "result" }>> {
	return await kernel.run({ cellId: `cell-${crypto.randomUUID()}`, code, timeoutMs: 3_000 });
}

describe("PythonKernel transport", () => {
	it("spawns the prelude without leaking bridge secrets through argv", async () => {
		const child = new FakeChild();
		const spawns: KernelSpawnOptions[] = [];
		const connection: BridgeConnectionConfig = { port: 4567, token: "secret-token" };
		const kernel = await PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "mock-session",
			cwd: process.cwd(),
			connection,
			spawnProcess: (options) => {
				spawns.push(options);
				return child;
			},
		});
		await kernel.close();

		expect(spawns).toHaveLength(1);
		expect(spawns[0]?.args.join(" ")).not.toContain(String(connection.port));
		expect(spawns[0]?.args.join(" ")).not.toContain(connection.token);
	});

	it("surfaces startup crashes as init failures", async () => {
		const child = new FakeChild(false);
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "crash-session",
			cwd: process.cwd(),
			connection: { port: 1, token: "t" },
			startupTimeoutMs: 200,
			spawnProcess: () => child,
		});
		child.stderr.write("boom\n");
		child.finish(1, null);
		await expect(started).rejects.toThrow(/boom|exited/i);
	});
});

describe.skipIf(!(await hasPython3()))("PythonKernel live", () => {
	it("persists state across cells and reset clears it", async () => {
		const kernel = await liveKernel();
		try {
			await runCell(kernel, "x = 1");
			await expect(runCell(kernel, "x + 1")).resolves.toMatchObject({ ok: true, valueRepr: "2" });
			await kernel.reset();
			await expect(runCell(kernel, "'x' in globals()")).resolves.toMatchObject({ ok: true, valueRepr: "False" });
		} finally {
			await kernel.close();
		}
	});

	it("supports top-level await and tracebacks", async () => {
		const kernel = await liveKernel();
		try {
			await expect(runCell(kernel, "import asyncio\nawait asyncio.sleep(0)\n42")).resolves.toMatchObject({
				ok: true,
				valueRepr: "42",
			});
			const failed = await runCell(kernel, "raise RuntimeError('kaput')");
			expect(failed.ok).toBe(false);
			if (!failed.ok) expect(failed.error.stack).toContain("RuntimeError: kaput");
		} finally {
			await kernel.close();
		}
	});

	it("calls host tools through the loopback bridge", async () => {
		const requests: unknown[] = [];
		const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
			let raw = "";
			req.setEncoding("utf8");
			req.on("data", (chunk) => {
				raw += chunk;
			});
			await once(req, "end");
			requests.push(JSON.parse(raw) as unknown);
			expect(req.headers.authorization).toBe("Bearer bridge-token");
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ok: true, value: { echoed: true } }));
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("missing server port");
		const kernel = await PythonKernel.start({
			interpreterPath: (await createInterpreterDetector().detect("py")).ok ? "python3" : "python",
			sessionId: "tool-session",
			cwd: process.cwd(),
			connection: { port: address.port, token: "bridge-token" },
		});
		try {
			await expect(runCell(kernel, "tool.echo_tool({'q': 'hi'})")).resolves.toMatchObject({
				ok: true,
				valueRepr: "{'echoed': True}",
			});
			expect(requests).toContainEqual({ kind: "tool", toolName: "echo_tool", args: { q: "hi" } });
		} finally {
			await kernel.close();
			server.close();
		}
	});
});
