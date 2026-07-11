import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { type BridgeHttpCallRequest, startBridgeServer } from "../src/bridge/http-server.ts";
import type { BridgeConnectionConfig } from "../src/bridge/protocol.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { type KernelSpawnOptions, PythonKernel } from "../src/kernels/py/kernel.ts";
import { FakeChild, hasPython3, liveKernel, runCell } from "./py-kernel/fixtures.ts";

describe("PythonKernel transport", () => {
	it("prelude speaks the loopback bridge server HTTP contract", async () => {
		const source = await readFile(new URL("../src/kernels/py/prelude.py", import.meta.url), "utf8");

		expect(source).toContain("/call");
		expect(source).toContain("/completion");
		expect(source).toContain('"callId"');
		expect(source).toContain('"opts"');
		expect(source).not.toContain('"kind": "tool"');
		expect(source).not.toContain('"kind": "completion"');
	});

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
		const child = new FakeChild({ autoReady: false, autoRun: false });
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
		const requests: BridgeHttpCallRequest[] = [];
		const server = await startBridgeServer({
			token: "bridge-token",
			onCall: async (request) => {
				requests.push(request);
				return { echoed: true, callId: request.callId };
			},
			onEmit: async () => {},
			onCompletion: async () => "unused",
		});
		const kernel = await PythonKernel.start({
			interpreterPath: (await createInterpreterDetector().detect("py")).ok ? "python3" : "python",
			sessionId: "tool-session",
			cwd: process.cwd(),
			connection: { port: server.port, token: server.token },
		});
		try {
			await expect(runCell(kernel, "tool.echo_tool({'q': 'hi'})")).resolves.toMatchObject({
				ok: true,
				valueRepr: expect.stringContaining("'echoed': True"),
			});
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({ toolName: "echo_tool", args: { q: "hi" } });
			expect(requests[0]?.callId).toMatch(/^py-/);
		} finally {
			await kernel.close();
			await server.close();
		}
	});

	it("sends completions to the bridge completion route", async () => {
		const completions: { readonly prompt: string; readonly opts?: unknown }[] = [];
		const server = await startBridgeServer({
			token: "completion-token",
			onCall: async () => "unused",
			onEmit: async () => {},
			onCompletion: async (request) => {
				completions.push({ prompt: request.prompt, opts: request.opts });
				return "completion-ok";
			},
		});
		const kernel = await PythonKernel.start({
			interpreterPath: (await createInterpreterDetector().detect("py")).ok ? "python3" : "python",
			sessionId: "completion-session",
			cwd: process.cwd(),
			connection: { port: server.port, token: server.token },
		});
		try {
			await expect(runCell(kernel, "completion('Say hi', temperature=0)")).resolves.toMatchObject({
				ok: true,
				valueRepr: "'completion-ok'",
			});
			expect(completions).toEqual([{ prompt: "Say hi", opts: { temperature: 0 } }]);
		} finally {
			await kernel.close();
			await server.close();
		}
	});
});
