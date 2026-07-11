import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

interface ChildRun {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly pid: number;
}

describe("JavaScriptKernel isolated inline fallback", () => {
	it("times out a synchronous infinite loop and leaves no live child process", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-js-inline-fallback-"));
		try {
			const scriptPath = join(root, "fallback-runner.mjs");
			const kernelUrl = pathToFileURL(join(process.cwd(), "src", "kernels", "js", "context-manager.ts")).href;
			const missingWorkerUrl = pathToFileURL(join(root, "missing-worker-entry.js")).href;
			await writeFile(
				scriptPath,
				`import { JavaScriptKernel } from ${JSON.stringify(kernelUrl)};

const kernel = new JavaScriptKernel({
  sessionId: "isolated-inline-fallback",
  cwd: process.cwd(),
  parallelPoolWidth: 2,
  workerEntryUrl: new URL(${JSON.stringify(missingWorkerUrl)}),
});
const baselineWorkerIds = process.report.getReport().workers.map((worker) => worker.header.threadId);
try {
  const result = await kernel.run({ cellId: "infinite-loop", code: "return (() => { while (true) {} })()", timeoutMs: 150 });
  await kernel.close();
  await new Promise((resolve) => setImmediate(resolve));
  const liveWorkerIds = process.report.getReport().workers
    .map((worker) => worker.header.threadId)
    .filter((threadId) => !baselineWorkerIds.includes(threadId));
  process.stdout.write(JSON.stringify({ mode: kernel.mode, result, liveWorkerIds }));
} finally {
  await kernel.close();
}
`,
			);

			const childRun = await runChildWithDeadline(scriptPath, 5_000);
			expect(childRun.signal, JSON.stringify(childRun)).toBeNull();
			expect(childRun.code).toBe(0);
			expect(childRun.stderr).toBe("");
			const output: unknown = JSON.parse(childRun.stdout);
			expect(output).toMatchObject({
				mode: "inline",
				result: { ok: false, error: { message: expect.stringMatching(/timed out/i) } },
				liveWorkerIds: [],
			});
			expect(isProcessAlive(childRun.pid)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 8_000);
});

async function runChildWithDeadline(scriptPath: string, deadlineMs: number): Promise<ChildRun> {
	const child = spawn(process.execPath, ["--import", "tsx", scriptPath], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	const pid = child.pid;
	if (pid === undefined) throw new Error("failed to spawn inline fallback test child");
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const result = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
		(resolve) => {
			const deadline = setTimeout(() => child.kill("SIGKILL"), deadlineMs);
			child.once("exit", (code, signal) => {
				clearTimeout(deadline);
				resolve({ code, signal });
			});
		},
	);
	return { ...result, stdout, stderr, pid };
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}
