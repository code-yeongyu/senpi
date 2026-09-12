import { afterEach, describe, expect, it } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import {
	createSpawnLoggingWorkerEntry,
	removeWorkerEntry,
	type SpawnLoggingWorkerEntry,
	spawnCount,
} from "./eval/js-worker-spawn-log.ts";

const UNRESPONSIVE_INTERRUPT_BUDGET_MS = 5_000;
const BLOCKED_WORKER_STOP_BUDGET_MS = 4_500;
const BLOCKED_WORKER_HOLD_MS = 8_000;
const FRESH_WORKER_RUN_BUDGET_MS = 1_500;

const kernels = new Set<JavaScriptKernel>();
const entries = new Set<SpawnLoggingWorkerEntry>();

afterEach(async () => {
	await Promise.all([...kernels].map(async (kernel) => await kernel.close()));
	await Promise.all([...entries].map(async (entry) => await removeWorkerEntry(entry)));
	kernels.clear();
	entries.clear();
});

async function createKernel(): Promise<{
	readonly kernel: JavaScriptKernel;
	readonly entry: SpawnLoggingWorkerEntry;
}> {
	const entry = await createSpawnLoggingWorkerEntry();
	entries.add(entry);
	const kernel = new JavaScriptKernel({
		sessionId: `cooperative-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		parallelPoolWidth: 2,
		workerEntryUrl: entry.url,
	});
	kernels.add(kernel);
	return { kernel, entry };
}

async function releaseBridgeCall(kernel: JavaScriptKernel): Promise<void> {
	const call = await kernel.nextToolCall();
	kernel.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value: null });
}

async function elapsed<T>(operation: Promise<T>): Promise<{ readonly value: T; readonly ms: number }> {
	const startedAt = performance.now();
	const value = await operation;
	return { value, ms: performance.now() - startedAt };
}

describe("JavaScriptKernel cooperative interrupt", () => {
	it("Given a cell parked on a promise nothing settles when interrupted then the worker restarts and the note is truthful", async () => {
		const { kernel, entry } = await createKernel();
		const run = kernel.run({
			cellId: "unresponsive",
			code: "globalThis.stuckMarker = 1; await tool.started({}); await new Promise(() => {})",
			timeoutMs: 60_000,
		});
		await releaseBridgeCall(kernel);

		const { value: handle, ms } = await elapsed(kernel.interrupt("unresponsive-stop"));

		expect(ms).toBeLessThan(UNRESPONSIVE_INTERRUPT_BUDGET_MS);
		await expect(run).resolves.toMatchObject({
			ok: false,
			error: { message: expect.stringContaining("unresponsive-stop") },
		});
		await expect(handle.stateRetained).resolves.toBe(false);
		await expect(
			kernel.run({ cellId: "after-restart", code: "return typeof stuckMarker", timeoutMs: 2_000 }),
		).resolves.toMatchObject({ ok: true, valueRepr: '"undefined"' });
		expect(await spawnCount(entry)).toBe(2);
	});

	it("Given a worker blocked in a synchronous child call when interrupted then a fresh worker replaces it within the stop deadline", async () => {
		const { kernel, entry } = await createKernel();
		const holdScript = `setTimeout(() => {}, ${BLOCKED_WORKER_HOLD_MS})`;
		const run = kernel.run({
			cellId: "sync-block",
			code: [
				'const { spawnSync } = await import("node:child_process");',
				"await tool.started({});",
				`spawnSync(process.execPath, ["-e", ${JSON.stringify(holdScript)}]);`,
				'return "unblocked";',
			].join("\n"),
			timeoutMs: 60_000,
		});
		await releaseBridgeCall(kernel);

		const { value: handle, ms } = await elapsed(kernel.interrupt("sync-stop"));

		expect(ms).toBeLessThan(BLOCKED_WORKER_STOP_BUDGET_MS);
		await expect(run).resolves.toMatchObject({
			ok: false,
			error: { message: expect.stringContaining("sync-stop") },
		});
		await expect(handle.stateRetained).resolves.toBe(false);
		expect(handle.note).toMatch(/synchronous/iu);
		const next = await elapsed(kernel.run({ cellId: "after-block", code: "return 42", timeoutMs: 2_000 }));
		expect(next.value).toMatchObject({ ok: true, valueRepr: "42" });
		expect(next.ms).toBeLessThan(FRESH_WORKER_RUN_BUDGET_MS);
		expect(await spawnCount(entry)).toBe(2);
	});

	it("Given a cell awaiting a bridge call when its kernel timeout fires then the cell times out and the worker state survives", async () => {
		const { kernel, entry } = await createKernel();
		const run = kernel.run({
			cellId: "timeout-retain",
			code: "globalThis.timeoutMarker = 1; return await tool.started({})",
			timeoutMs: 400,
		});
		await kernel.nextToolCall();

		await expect(run).resolves.toMatchObject({
			ok: false,
			error: { message: expect.stringMatching(/timed out/iu) },
		});
		await expect(
			kernel.run({ cellId: "after-timeout", code: "return timeoutMarker", timeoutMs: 2_000 }),
		).resolves.toMatchObject({ ok: true, valueRepr: "1" });
		expect(await spawnCount(entry)).toBe(1);
	});
});
