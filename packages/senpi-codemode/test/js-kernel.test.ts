// allow: SIZE_OK — todo 7 parity cases must remain in the plan-listed js-kernel test file.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { JavaScriptKernel, type JavaScriptKernelMode } from "../src/kernels/js/context-manager.ts";

interface CapturedRun {
	readonly result: Extract<KernelToHostMessage, { type: "result" }>;
	readonly messages: readonly KernelToHostMessage[];
}

async function withKernel<T>(
	fn: (kernel: JavaScriptKernel, messages: KernelToHostMessage[]) => Promise<T>,
): Promise<T> {
	const messages: KernelToHostMessage[] = [];
	const kernel = new JavaScriptKernel({
		sessionId: "test-session",
		cwd: process.cwd(),
		parallelPoolWidth: 2,
		onMessage: (message) => messages.push(message),
	});
	try {
		return await fn(kernel, messages);
	} finally {
		await kernel.close();
	}
}

async function runCell(kernel: JavaScriptKernel, code: string, timeoutMs = 2_000): Promise<CapturedRun> {
	const messages: KernelToHostMessage[] = [];
	const result = await kernel.run({
		cellId: `cell-${crypto.randomUUID()}`,
		code,
		timeoutMs,
		onMessage: (message) => messages.push(message),
	});
	return { result, messages };
}

describe("JavaScriptKernel", () => {
	it.each([
		{
			name: "worker",
			expectedMode: "worker",
			workerEntryUrl: new URL("../src/kernels/js/worker-entry.js", import.meta.url),
		},
		{
			name: "inline fallback",
			expectedMode: "inline",
			workerEntryUrl: pathToFileURL(join(process.cwd(), "missing-characterization-worker.js")),
		},
	] satisfies readonly {
		readonly name: string;
		readonly expectedMode: JavaScriptKernelMode;
		readonly workerEntryUrl: URL;
	}[])("preserves the $name happy path", async ({ expectedMode, workerEntryUrl }) => {
		const kernel = new JavaScriptKernel({
			sessionId: `characterization-${expectedMode}`,
			cwd: process.cwd(),
			parallelPoolWidth: 2,
			workerEntryUrl,
		});
		try {
			const result = await kernel.run({ cellId: "characterization", code: "return 20 + 22", timeoutMs: 2_000 });
			expect(kernel.mode).toBe(expectedMode);
			expect(result).toMatchObject({ ok: true, valueRepr: "42" });
		} finally {
			await kernel.close();
		}
	});

	it("persists state across cells and reset wipes it", async () => {
		await withKernel(async (kernel) => {
			await runCell(kernel, "const a = 1");
			const second = await runCell(kernel, "return a + 1");
			expect(second.result).toMatchObject({ ok: true, valueRepr: "2" });

			await kernel.reset();
			const afterReset = await runCell(kernel, "return typeof a");
			expect(afterReset.result).toMatchObject({ ok: true, valueRepr: '"undefined"' });
		});
	});

	it("round-trips tool calls without executing host tools in the worker", async () => {
		await withKernel(async (kernel) => {
			const run = kernel.run({
				cellId: "tool-cell",
				code: "return await tool.read({ path: 'demo.txt' })",
				timeoutMs: 2_000,
			});
			const call = await kernel.nextToolCall();
			expect(call).toMatchObject({ type: "tool-call", toolName: "read", args: { path: "demo.txt" } });
			kernel.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value: "from-host" });
			const result = await run;
			expect(result).toMatchObject({ ok: true, valueRepr: '"from-host"' });
		});
	});

	it("round-trips env values inside the persistent runtime", async () => {
		await withKernel(async (kernel) => {
			// Given a live JavaScript kernel
			// When a cell sets and reads an environment override
			const run = await runCell(kernel, 'env("CODEMODE_JS_ENV", "value"); return env("CODEMODE_JS_ENV")');

			// Then the override is returned to user code
			expect(run.result).toMatchObject({ ok: true, valueRepr: '"value"' });
		});
	});

	it("imports Node builtins from a cell", async () => {
		await withKernel(async (kernel) => {
			// Given a live JavaScript kernel
			// When a cell uses a static ESM import
			const run = await runCell(kernel, 'import fs from "node:fs"; return typeof fs.readFileSync');

			// Then the imported namespace is available to the cell
			expect(run.result).toMatchObject({ ok: true, valueRepr: '"function"' });
		});
	});

	it("imports a relative module from the session cwd", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-js-import-"));
		await writeFile(join(root, "module.mjs"), "export const value = 41;\n");
		const kernel = new JavaScriptKernel({ sessionId: "relative-import", cwd: root, parallelPoolWidth: 2 });
		try {
			// Given an ESM module beside the session cell
			// When the cell imports it by a relative specifier
			const run = await runCell(kernel, 'import { value } from "./module.mjs"; return value + 1');

			// Then resolution starts from the session cwd
			expect(run.result).toMatchObject({ ok: true, valueRepr: "42" });
		} finally {
			await kernel.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("imports local protocol modules from the configured root", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-js-local-"));
		const localRoot = join(root, "local");
		await mkdir(localRoot, { recursive: true });
		await writeFile(join(localRoot, "module.mjs"), "export const value = 42;\n");
		const kernel = new JavaScriptKernel({
			sessionId: "local-import",
			cwd: root,
			parallelPoolWidth: 2,
			localRoots: { local: localRoot },
			artifactsDir: root,
		});
		try {
			// Given a local:// root supplied by the session
			// When the cell imports a module through that protocol
			const run = await runCell(kernel, 'import { value } from "local://module.mjs"; return value');

			// Then the module stays confined to the configured root
			expect(run.result).toMatchObject({ ok: true, valueRepr: "42" });
		} finally {
			await kernel.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("emits a status frame when write completes", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-js-status-"));
		const kernel = new JavaScriptKernel({
			sessionId: "write-status",
			cwd: root,
			parallelPoolWidth: 2,
		});
		try {
			// Given a writable session directory
			// When a cell writes a UTF-8 file
			const run = await runCell(kernel, 'await write("status.txt", "hello")');

			// Then the kernel reports the observable write operation
			expect(run.messages).toContainEqual({
				type: "status",
				event: { op: "write", path: join(root, "status.txt"), bytes: 5 },
			});
		} finally {
			await kernel.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("marshals agent options through the reserved bridge tool", async () => {
		await withKernel(async (kernel) => {
			// Given an active cell with a host tool bridge
			// When user code calls agent() with the supported options object
			const run = kernel.run({
				cellId: "agent-cell",
				code: `return await agent("inspect", {
				  agent: "reviewer",
				  model: "model-x",
				  label: "review",
				  isolated: true,
				  apply: false,
				  merge: true
				})`,
				timeoutMs: 2_000,
			});
			const observed = await Promise.race([
				kernel.nextToolCall().then((call) => ({ kind: "call", call }) as const),
				run.then((result) => ({ kind: "result", result }) as const),
			]);

			// Then the reserved tool receives every option without executing in the worker
			expect(observed.kind).toBe("call");
			if (observed.kind !== "call") return;
			expect(observed.call).toMatchObject({
				type: "tool-call",
				toolName: "__agent__",
				args: {
					prompt: "inspect",
					agent: "reviewer",
					model: "model-x",
					label: "review",
					isolated: true,
					apply: false,
					merge: true,
					handle: false,
				},
			});
			kernel.deliverToolReply({ type: "tool-reply", callId: observed.call.callId, ok: true, value: "done" });
			await expect(run).resolves.toMatchObject({ ok: true, valueRepr: '"done"' });
		});
	});

	it("emits status frames for env and read operations", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-js-helper-status-"));
		await writeFile(join(root, "input.txt"), "hello");
		const kernel = new JavaScriptKernel({ sessionId: "helper-status", cwd: root, parallelPoolWidth: 2 });
		try {
			// Given a readable file and an active environment overlay
			// When a cell sets env state and reads the file
			const run = await runCell(kernel, 'env("STATUS_KEY", "VALUE"); await read("input.txt")');

			// Then both helper operations emit structured status frames
			expect(run.messages).toEqual(
				expect.arrayContaining([
					{ type: "status", event: { op: "env", key: "STATUS_KEY", value: "VALUE", action: "set" } },
					{ type: "status", event: { op: "read", path: join(root, "input.txt"), bytes: 5, chars: 5 } },
				]),
			);
		} finally {
			await kernel.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("marshals output ids through the reserved bridge tool", async () => {
		await withKernel(async (kernel) => {
			// Given an active cell with a host tool bridge
			// When user code requests multiple task outputs
			const run = kernel.run({
				cellId: "output-cell",
				code: 'return await output("task-a", "task-b", { format: "tail", offset: 2, limit: 5 })',
				timeoutMs: 2_000,
			});
			const observed = await Promise.race([
				kernel.nextToolCall().then((call) => ({ kind: "call", call }) as const),
				run.then((result) => ({ kind: "result", result }) as const),
			]);

			// Then the reserved output tool receives the ids and options
			expect(observed.kind).toBe("call");
			if (observed.kind !== "call") return;
			expect(observed.call).toMatchObject({
				toolName: "__output__",
				args: { ids: ["task-a", "task-b"], format: "tail", offset: 2, limit: 5 },
			});
			kernel.deliverToolReply({
				type: "tool-reply",
				callId: observed.call.callId,
				ok: true,
				value: ["first", "second"],
			});
			await expect(run).resolves.toMatchObject({ ok: true, valueRepr: '["first","second"]' });
		});
	});

	it("emits markdown display frames", async () => {
		await withKernel(async (kernel) => {
			// Given a markdown display value
			// When the cell displays it
			const run = await runCell(kernel, 'display({ type: "markdown", text: "# Heading" })');

			// Then the bridge receives the markdown MIME payload
			expect(run.messages).toContainEqual({
				type: "display",
				mimeType: "text/markdown",
				dataBase64: Buffer.from("# Heading", "utf8").toString("base64"),
			});
		});
	});

	it("supports bare top-level await", async () => {
		await withKernel(async (kernel) => {
			const run = await runCell(kernel, "await Promise.resolve(42)");
			expect(run.result).toMatchObject({ ok: true, valueRepr: "42" });
		});
	});

	it("captures the last expression after awaited statements", async () => {
		await withKernel(async (kernel) => {
			const run = await runCell(kernel, "const y = await Promise.resolve(41)\ny + 1");
			expect(run.result).toMatchObject({ ok: true, valueRepr: "42" });
		});
	});

	it("keeps a second queued cell behind an active tool call", async () => {
		await withKernel(async (kernel) => {
			const first = kernel.run({ cellId: "first", code: "return await tool.slow({ n: 1 })", timeoutMs: 2_000 });
			const second = kernel.run({ cellId: "second", code: "return 41 + 1", timeoutMs: 2_000 });
			const call = await kernel.nextToolCall();
			kernel.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value: "done" });
			await expect(first).resolves.toMatchObject({ ok: true, valueRepr: '"done"' });
			await expect(second).resolves.toMatchObject({ ok: true, valueRepr: "42" });
		});
	});

	it("aborts a stuck cell by terminating and respawning the worker", async () => {
		await withKernel(async (kernel) => {
			const stuck = await runCell(kernel, "while (true) {}", 500);
			expect(stuck.result.ok).toBe(false);
			if (!stuck.result.ok) expect(stuck.result.error.message).toMatch(/timed out/i);

			const fresh = await runCell(kernel, "return typeof a");
			expect(fresh.result).toMatchObject({ ok: true, valueRepr: '"undefined"' });
		});
	});

	it("uses inline fallback when worker spawn fails", async () => {
		const messages: KernelToHostMessage[] = [];
		const kernel = new JavaScriptKernel({
			sessionId: "fallback",
			cwd: process.cwd(),
			parallelPoolWidth: 2,
			onMessage: (message) => messages.push(message),
			workerEntryUrl: pathToFileURL(join(process.cwd(), "missing-worker-entry.js")),
		});
		try {
			const result = await kernel.run({ cellId: "fallback-cell", code: "return 20 + 22", timeoutMs: 2_000 });
			expect(kernel.mode).toBe("inline");
			expect(result).toMatchObject({ ok: true, valueRepr: "42" });
		} finally {
			await kernel.close();
		}
	});

	it("parallel preserves input order and bounds concurrency", async () => {
		await withKernel(async (kernel) => {
			const result = await runCell(
				kernel,
				`
let inFlight = 0;
let max = 0;
const values = await parallel([1, 2, 3, 4].map((n) => async () => {
  inFlight++;
  max = Math.max(max, inFlight);
  await new Promise((resolve) => setTimeout(resolve, 25));
  inFlight--;
  return n * 2;
}));
return { values, max };
`,
			);
			expect(result.result).toMatchObject({ ok: true, valueRepr: '{"values":[2,4,6,8],"max":2}' });
		});
	});

	it("returns clean syntax errors and keeps the worker usable", async () => {
		await withKernel(async (kernel) => {
			const bad = await runCell(kernel, "const =");
			expect(bad.result.ok).toBe(false);
			if (!bad.result.ok) expect(bad.result.error.message).toContain("Unexpected");

			const good = await runCell(kernel, "return 7");
			expect(good.result).toMatchObject({ ok: true, valueRepr: "7" });
		});
	});

	it("emits display, print/log, phase, and stdout/stderr text events", async () => {
		await withKernel(async (kernel) => {
			const run = await runCell(
				kernel,
				`
print("printed");
console.error("errored");
display({ hello: "world" });
log("logged");
phase("phase title");
return "done";
`,
			);
			expect(run.messages).toContainEqual({ type: "text", stream: "stdout", data: "printed\n" });
			expect(run.messages).toContainEqual({ type: "text", stream: "stderr", data: "errored\n" });
			expect(run.messages).toContainEqual({
				type: "display",
				mimeType: "application/json",
				dataBase64: Buffer.from(JSON.stringify({ hello: "world" }), "utf8").toString("base64"),
			});
			expect(run.messages).toContainEqual({ type: "log", message: "logged" });
			expect(run.messages).toContainEqual({ type: "phase", title: "phase title" });
			expect(run.result).toMatchObject({ ok: true, valueRepr: '"done"' });
		});
	});

	it("runs a copied node_modules worker graph without TypeScript imports", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-node-modules-"));
		try {
			const packageDir = join(root, "node_modules", "@code-yeongyu", "senpi-codemode");
			await mkdir(packageDir, { recursive: true });
			await cp(join(process.cwd(), "src"), join(packageDir, "src"), { recursive: true });
			await writeFile(join(packageDir, "package.json"), JSON.stringify({ type: "module" }));

			const entry = join(packageDir, "src", "kernels", "js", "worker-entry.js");
			const kernel = new JavaScriptKernel({
				sessionId: "installed",
				cwd: root,
				parallelPoolWidth: 2,
				workerEntryUrl: pathToFileURL(entry),
			});
			try {
				const result = await kernel.run({ cellId: "installed-cell", code: "return 21 * 2", timeoutMs: 2_000 });
				expect(kernel.mode).toBe("worker");
				expect(result).toMatchObject({ ok: true, valueRepr: "42" });
			} finally {
				await kernel.close();
			}

			const seen = new Set<string>();
			const stack = [entry];
			while (stack.length > 0) {
				const file = stack.pop();
				if (!file || seen.has(file)) continue;
				seen.add(file);
				const source = await readFile(file, "utf8");
				for (const match of source.matchAll(/from\s+["'](\.\/[^"']+)["']/gu)) {
					const specifier = match[1];
					expect(specifier.endsWith(".ts")).toBe(false);
					if (specifier.endsWith(".js")) stack.push(fileURLToPath(new URL(specifier, pathToFileURL(file))));
				}
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("preserves input order through a bounded pool under controlled jitter", async () => {
		const heldCalls: Extract<KernelToHostMessage, { type: "tool-call" }>[] = [];
		let kernel: JavaScriptKernel | undefined;
		let markerSeen = false;
		let releasedFirstWave = false;
		const reply = (call: Extract<KernelToHostMessage, { type: "tool-call" }>): void => {
			const activeKernel = kernel;
			if (!activeKernel) throw new Error("kernel is unavailable");
			activeKernel.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value: call.args });
		};
		const releaseFirstWave = (): void => {
			if (!markerSeen || releasedFirstWave || heldCalls.length < 2) return;
			const first = heldCalls[0];
			const second = heldCalls[1];
			if (!first || !second) throw new Error("missing first-wave tool calls");
			releasedFirstWave = true;
			reply(second);
			reply(first);
		};
		kernel = new JavaScriptKernel({
			sessionId: "parallel-width",
			cwd: process.cwd(),
			parallelPoolWidth: 2,
			onMessage: (message) => {
				if (message.type !== "tool-call") return;
				if (message.toolName === "marker") {
					markerSeen = true;
					reply(message);
					releaseFirstWave();
					return;
				}
				if (message.toolName !== "hold") throw new Error("unexpected tool call");
				if (releasedFirstWave) {
					reply(message);
					return;
				}
				heldCalls.push(message);
				releaseFirstWave();
			},
		});
		try {
			// Given: four thunks whose first two calls are held by the bridge.
			const result = await kernel.run({
				cellId: "parallel-width",
				code: `let active = 0;
const work = async (index) => {
  active += 1;
  if (active > 2) throw new Error("pool width exceeded");
  if (active === 2) await tool.marker({});
  const value = await tool.hold({ index });
  active -= 1;
  return value;
};
return await parallel([0, 1, 2, 3].map((index) => async () => await work(index)));`,
				timeoutMs: 2_000,
			});

			// When: the bridge resolves the held wave out of input order.
			// Then: pool width remains bounded and results retain input order.
			expect(heldCalls).toHaveLength(2);
			expect(result).toMatchObject({
				ok: true,
				valueRepr: '[{"index":0},{"index":1},{"index":2},{"index":3}]',
			});
		} finally {
			await kernel.close();
		}
	});

	it("propagates the lowest-index parallel error after every worker settles", async () => {
		await withKernel(async (kernel) => {
			// Given: a lower-index thunk blocked on a bridge reply and a higher-index failure.
			const run = kernel.run({
				cellId: "parallel-error",
				code: `return await parallel([
  async () => { await tool.gate({}); throw new Error("idx0"); },
  async () => { throw new Error("idx1"); }
]);`,
				timeoutMs: 2_000,
			});
			const gate = await kernel.nextToolCall();
			expect(gate).toMatchObject({ toolName: "gate" });

			// When: the lower-index thunk is allowed to finish after the higher-index failure.
			kernel.deliverToolReply({ type: "tool-reply", callId: gate.callId, ok: true, value: "released" });
			const result = await run;

			// Then: the result reports the lowest-index failure.
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).toContain("idx0");
		});
	});

	it("keeps every pipeline stage behind the preceding stage barrier", async () => {
		await withKernel(async (kernel) => {
			// Given: stages recording deterministic logical timestamps after asynchronous yields.
			const run = await runCell(
				kernel,
				`let logicalTime = 0;
const stageOneEnds = [];
const stageTwoStarts = [];
const stageOne = async (value) => {
  await Promise.resolve();
  stageOneEnds.push(++logicalTime);
  return value;
};
const stageTwo = async (value) => {
  stageTwoStarts.push(++logicalTime);
  return value;
};
const values = await pipeline([0, 1, 2], stageOne, stageTwo);
return { values, barrier: Math.min(...stageTwoStarts) >= Math.max(...stageOneEnds) };`,
			);

			// When: both pipeline stages run.
			// Then: stage two starts only after every stage-one completion.
			expect(run.result).toMatchObject({ ok: true, valueRepr: '{"values":[0,1,2],"barrier":true}' });
		});
	});
});
