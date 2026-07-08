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

	it("runs from node_modules in worker mode and worker graph imports no TypeScript", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-codemode-node-modules-"));
		try {
			const packageDir = join(root, "node_modules", "@code-yeongyu", "senpi-codemode");
			await mkdir(packageDir, { recursive: true });
			await cp(join(process.cwd(), "src"), join(packageDir, "src"), { recursive: true });
			await writeFile(join(packageDir, "package.json"), JSON.stringify({ type: "module" }));

			const module = (await import(
				pathToFileURL(join(packageDir, "src", "kernels", "js", "context-manager.ts")).href
			)) as {
				JavaScriptKernel: new (options: {
					sessionId: string;
					cwd: string;
					parallelPoolWidth: number;
					onMessage?: (message: KernelToHostMessage) => void;
				}) => {
					readonly mode: JavaScriptKernelMode;
					run(input: { cellId: string; code: string; timeoutMs?: number }): Promise<KernelToHostMessage>;
					close(): Promise<void>;
				};
			};
			const kernel = new module.JavaScriptKernel({
				sessionId: "installed",
				cwd: root,
				parallelPoolWidth: 2,
			});
			try {
				const result = await kernel.run({ cellId: "installed-cell", code: "return 21 * 2", timeoutMs: 2_000 });
				expect(kernel.mode).toBe("worker");
				expect(result).toMatchObject({ ok: true, valueRepr: "42" });
			} finally {
				await kernel.close();
			}

			const entry = join(packageDir, "src", "kernels", "js", "worker-entry.js");
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
});
