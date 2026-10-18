import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CHILD_PROBE_TEST_TIMEOUT_MS, startChild } from "./eval/child-probe.ts";

describe("JavaScriptKernel isolated inline fallback", () => {
	it(
		"times out a synchronous infinite loop and leaves no live child process",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "senpi-js-inline-fallback-"));
			try {
				const scriptPath = join(root, "fallback-runner.mjs");
				const kernelUrl = pathToFileURL(join(process.cwd(), "src", "kernels", "js", "context-manager.ts")).href;
				const missingWorkerUrl = pathToFileURL(join(root, "missing-worker-entry.js")).href;
				const driverUrl = pathToFileURL(join(process.cwd(), "test", "eval", "inline-timeout-probe.ts")).href;
				await writeFile(
					scriptPath,
					`import { JavaScriptKernel } from ${JSON.stringify(kernelUrl)};
import { mock } from "node:test";
import { Worker } from "node:worker_threads";
import { driveInlineTimeout, INLINE_PROBE_BOUNDS } from ${JSON.stringify(driverUrl)};

const terminations = [];
const originalTerminate = Worker.prototype.terminate;
Worker.prototype.terminate = function () {
  const terminated = originalTerminate.call(this);
  terminations.push(terminated);
  return terminated;
};
let loopStarted;
const started = new Promise((resolve) => { loopStarted = resolve; });
const kernel = new JavaScriptKernel({
  sessionId: "isolated-inline-fallback",
  cwd: process.cwd(),
  parallelPoolWidth: 2,
  workerEntryUrl: new URL(${JSON.stringify(missingWorkerUrl)}),
  onMessage: (message) => { if (message.type === "text" && message.data.includes("loop-started")) loopStarted(); },
  interruptBounds: INLINE_PROBE_BOUNDS,
});
const baselineWorkerIds = process.report.getReport().workers.map((worker) => worker.header.threadId);
try {
  await kernel.run({ cellId: "warm", code: "1 + 1" });
  mock.timers.enable({ apis: ["setTimeout"] });
  const running = kernel.run({ cellId: "infinite-loop", code: 'print("loop-started"); return (() => { while (true) {} })()', timeoutMs: INLINE_PROBE_BOUNDS.cellTimeoutMs });
  const result = await driveInlineTimeout(started, running, async (milliseconds) => {
    mock.timers.tick(milliseconds);
    await new Promise((resolve) => setImmediate(resolve));
  });
  mock.timers.reset();
  await kernel.close();
  await Promise.all(terminations);
  const liveWorkerIds = process.report.getReport().workers
    .map((worker) => worker.header.threadId)
    .filter((threadId) => !baselineWorkerIds.includes(threadId));
  process.stdout.write(JSON.stringify({ mode: kernel.mode, result, liveWorkerIds }) + "\\n");
} finally {
  mock.timers.reset();
  await kernel.close();
  await Promise.all(terminations);
  Worker.prototype.terminate = originalTerminate;
}
`,
				);

				const child = startChild(
					{ command: process.execPath, args: ["--import", "tsx", scriptPath], cwd: process.cwd() },
					{ resultLine: true },
				);
				try {
					const output: unknown = JSON.parse(await child.resultLine());
					expect(output).toMatchObject({
						mode: "inline",
						result: { ok: false, error: { message: expect.stringMatching(/timed out/i) } },
						liveWorkerIds: [],
					});
					const childRun = await child.closed;
					expect(childRun.signal, JSON.stringify(childRun)).toBeNull();
					expect(childRun.code).toBe(0);
					expect(childRun.stderr).toBe("");
					expect(isProcessAlive(childRun.pid)).toBe(false);
				} finally {
					child.dispose();
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		CHILD_PROBE_TEST_TIMEOUT_MS,
	);
});

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}
