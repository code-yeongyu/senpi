import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";

interface CrashWorkerEntry {
	readonly root: string;
	readonly url: URL;
	readonly spawnLog: string;
}

const kernels = new Set<JavaScriptKernel>();
const entries = new Set<CrashWorkerEntry>();

afterEach(async () => {
	await Promise.all([...kernels].map(async (kernel) => await kernel.close()));
	await Promise.all([...entries].map(async (entry) => await rm(entry.root, { recursive: true, force: true })));
	kernels.clear();
	entries.clear();
});

function createKernel(entry: CrashWorkerEntry): JavaScriptKernel {
	const kernel = new JavaScriptKernel({
		sessionId: `crash-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		parallelPoolWidth: 2,
		workerEntryUrl: entry.url,
	});
	kernels.add(kernel);
	return kernel;
}

async function createCrashWorkerEntry(readyDelayMs: number, crashDelayMs: number): Promise<CrashWorkerEntry> {
	const root = await mkdtemp(join(tmpdir(), "senpi-js-crash-lifecycle-"));
	const entryPath = join(root, "worker-entry.mjs");
	const spawnLog = join(root, "spawns.txt");
	const coreUrl = pathToFileURL(join(process.cwd(), "src", "kernels", "js", "worker-core.js")).href;
	const source = `
import { appendFileSync, readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { createWorkerCore } from ${JSON.stringify(coreUrl)};

if (!parentPort) throw new Error("test worker missing parentPort");
appendFileSync(${JSON.stringify(spawnLog)}, "spawn\\n");
const currentSpawn = readFileSync(${JSON.stringify(spawnLog)}, "utf8").split("\\n").filter(Boolean).length;

if (currentSpawn === 1) {
  parentPort.on("message", (message) => {
    if (message.type === "init") {
      setTimeout(() => parentPort.postMessage({ type: "ready" }), ${readyDelayMs});
      return;
    }
    if (message.type === "run") {
      setTimeout(() => { throw new Error("intentional active-run crash"); }, ${crashDelayMs});
    }
  });
} else {
  const transport = {
    send(message) { parentPort.postMessage(message); },
    onMessage(handler) {
      parentPort.on("message", handler);
      return () => parentPort.off("message", handler);
    },
    close() { parentPort.close(); },
  };
  createWorkerCore(transport, { cwd: workerData.cwd, parallelPoolWidth: workerData.parallelPoolWidth });
}
`;
	await writeFile(entryPath, source);
	await appendFile(spawnLog, "");
	const entry = { root, url: pathToFileURL(entryPath), spawnLog };
	entries.add(entry);
	return entry;
}

async function spawnCount(entry: CrashWorkerEntry): Promise<number> {
	const contents = await readFile(entry.spawnLog, "utf8");
	return contents.split("\n").filter(Boolean).length;
}

describe("JavaScriptKernel worker crash lifecycle", () => {
	it("measures an active worker crash from the cell monotonic start", async () => {
		const entry = await createCrashWorkerEntry(1_000, 80);
		const kernel = createKernel(entry);

		const result = await kernel.run({ cellId: "crash-duration", code: "return 1", timeoutMs: 2_000 });

		expect(result).toMatchObject({
			ok: false,
			error: { message: expect.stringContaining("intentional active-run crash") },
		});
		expect(result.durationMs).toBeGreaterThanOrEqual(40);
		expect(result.durationMs).toBeLessThan(600);
	});

	it("restarts after an active worker crash and resumes the queued run", async () => {
		const entry = await createCrashWorkerEntry(0, 20);
		const kernel = createKernel(entry);
		const first = kernel.run({ cellId: "crash-first", code: "return 1", timeoutMs: 2_000 });
		const queued = kernel.run({ cellId: "crash-queued", code: "return 40 + 2", timeoutMs: 2_000 });

		await expect(first).resolves.toMatchObject({ ok: false });
		await expect(withDeadline(queued, 750)).resolves.toMatchObject({ ok: true, valueRepr: "42" });
		expect(await spawnCount(entry)).toBe(2);
	});
});

async function withDeadline<T>(promise: Promise<T>, delayMs: number): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timeout = setTimeout(
			() => reject(new Error(`queued JavaScript run did not settle within ${delayMs}ms`)),
			delayMs,
		);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
