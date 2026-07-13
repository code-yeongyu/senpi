// allow: SIZE_OK — parity cases stay beside the live kernel harness they exercise.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { type BridgeHttpCallRequest, startBridgeServer } from "../src/bridge/http-server.ts";
import type { BridgeConnectionConfig, KernelToHostMessage } from "../src/bridge/protocol.ts";
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

	it("translates shell escapes and keeps env state", async () => {
		// Given
		const messages: KernelToHostMessage[] = [];
		const kernel = await liveKernel({ onMessage: (message) => messages.push(message) });

		try {
			// When
			const result = await runCell(
				kernel,
				"!echo SHELL_OK\nenv('CM_ENV_ROUND_TRIP', 'V1'); print(env('CM_ENV_ROUND_TRIP'))",
			);

			// Then
			expect(result.ok).toBe(true);
			const stdout = messages
				.flatMap((message) => (message.type === "text" && message.stream === "stdout" ? [message.data] : []))
				.join("");
			expect(stdout).toContain("SHELL_OK");
			expect(stdout).toContain("V1");
			expect(messages).toContainEqual(
				expect.objectContaining({
					type: "status",
					event: { op: "env", key: "CM_ENV_ROUND_TRIP", value: "V1", action: "set" },
				}),
			);
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
	it("uses the bridge pool width and preserves input order under controlled jitter", async () => {
		const markerReceived = Promise.withResolvers<void>();
		const markerReply = Promise.withResolvers<string>();
		const firstHolds = Promise.withResolvers<void>();
		const held = new Map<number, (value: number | PromiseLike<number>) => void>();
		let releaseAdditionalHolds = false;
		const server = await startBridgeServer({
			token: "parallel-width-token",
			onCall: async (request) => {
				if (request.toolName === "marker") {
					markerReceived.resolve();
					return await markerReply.promise;
				}
				if (request.toolName !== "hold") throw new Error(`unexpected tool call: ${request.toolName}`);
				if (
					typeof request.args !== "object" ||
					request.args === null ||
					Array.isArray(request.args) ||
					!("index" in request.args) ||
					typeof request.args.index !== "number"
				) {
					throw new Error("hold requires a numeric index");
				}
				const index = request.args.index;
				if (releaseAdditionalHolds) return index;
				const deferred = Promise.withResolvers<number>();
				held.set(index, deferred.resolve);
				if (held.size === 2) firstHolds.resolve();
				return await deferred.promise;
			},
			onEmit: async () => undefined,
			onCompletion: async () => "unused",
		});
		const detected = await createInterpreterDetector().detect("py");
		if (!detected.ok) throw new Error("python unavailable");
		const connection = { port: server.port, token: server.token, parallelPoolWidth: 2 };
		const kernel = await PythonKernel.start({
			interpreterPath: detected.path,
			sessionId: "parallel-width",
			cwd: process.cwd(),
			connection,
		});
		try {
			// Given: a two-worker pool whose first wave is held by the bridge.
			const run = kernel.run({
				cellId: "parallel-width",
				code: `from threading import Lock
active = 0
active_lock = Lock()
def work(index):
    global active
    with active_lock:
        active += 1
        if active > 2:
            raise RuntimeError("pool width exceeded")
        if active == 2:
            tool.marker({})
    value = tool.hold({"index": index})
    with active_lock:
        active -= 1
    return value
parallel([lambda index=index: work(index) for index in range(4)])`,
				timeoutMs: 3_000,
			});

			// When: the first wave is released in reverse completion order.
			await markerReceived.promise;
			markerReply.resolve("marker");
			await firstHolds.promise;
			expect([...held.keys()].sort((left, right) => left - right)).toEqual([0, 1]);
			releaseAdditionalHolds = true;
			const releaseOne = held.get(1);
			const releaseZero = held.get(0);
			if (!releaseOne || !releaseZero) throw new Error("missing first-wave hold");
			releaseOne(1);
			releaseZero(0);

			// Then: the bounded pool completes every thunk while retaining input order.
			await expect(run).resolves.toMatchObject({ ok: true, valueRepr: "[0, 1, 2, 3]" });
		} finally {
			await kernel.close();
			await server.close();
		}
	});

	it("propagates the lowest-index parallel error after every worker settles", async () => {
		const kernel = await liveKernel();
		try {
			// Given: a lower-index thunk waiting for a higher-index thunk to fail.
			const result = await runCell(
				kernel,
				`from threading import Event
gate = Event()
def low():
    gate.wait()
    raise ValueError("idx0")
def high():
    gate.set()
    raise ValueError("idx1")
parallel([low, high])`,
			);

			// When: both thunks raise in controlled opposite completion order.
			// Then: the observable cell error is from the lowest input index.
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).toContain("idx0");
		} finally {
			await kernel.close();
		}
	});

	it("keeps every pipeline stage behind the preceding stage barrier", async () => {
		const kernel = await liveKernel();
		try {
			// Given: stages that record deterministic logical timestamps in the cell.
			const result = await runCell(
				kernel,
				`logical_time = 0
stage_one_ends = []
stage_two_starts = []
def stage_one(value):
    global logical_time
    logical_time += 1
    stage_one_ends.append(logical_time)
    return value
def stage_two(value):
    global logical_time
    logical_time += 1
    stage_two_starts.append(logical_time)
    return value
values = pipeline([0, 1, 2], stage_one, stage_two)
values == [0, 1, 2] and min(stage_two_starts) >= max(stage_one_ends)`,
			);

			// When: the pipeline executes both stages.
			// Then: every stage-two timestamp follows the final stage-one timestamp.
			expect(result).toMatchObject({ ok: true, valueRepr: "True" });
		} finally {
			await kernel.close();
		}
	});
});
