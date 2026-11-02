import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { createSpawnLoggingWorkerEntry, removeWorkerEntry, spawnCount } from "./eval/js-worker-spawn-log.ts";

const kernels = new Set<JavaScriptKernel>();

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all([...kernels].map(async (kernel) => await kernel.close()));
	kernels.clear();
});

function createKernel(
	options: { readonly workerEntryUrl?: URL; readonly onMessage?: (message: KernelToHostMessage) => void } = {},
): JavaScriptKernel {
	const kernel = new JavaScriptKernel({
		sessionId: `lifecycle-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		parallelPoolWidth: 2,
		...options,
	});
	kernels.add(kernel);
	return kernel;
}

describe("JavaScriptKernel lifecycle", () => {
	it("does not lose an interrupt while run awaits worker readiness", async () => {
		const entry = await createSpawnLoggingWorkerEntry(true);
		let readinessBlocked: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			readinessBlocked = resolve;
		});
		const kernel = createKernel({
			workerEntryUrl: entry.url,
			onMessage: (message) => {
				if (message.type === "phase" && message.title === "readiness-blocked") readinessBlocked?.();
			},
		});
		try {
			const run = kernel.run({ cellId: "before-ready", code: "return 1", timeoutMs: 2_000 });
			await blocked;

			await kernel.interrupt("interrupt-before-activation");

			await expect(run).resolves.toMatchObject({
				ok: false,
				error: { message: expect.stringContaining("interrupt-before-activation") },
			});
			await expect(
				kernel.run({ cellId: "after-ready", code: "return 42", timeoutMs: 2_000 }),
			).resolves.toMatchObject({
				ok: true,
				valueRepr: "42",
			});
			expect(await spawnCount(entry)).toBe(2);
		} finally {
			await removeWorkerEntry(entry);
		}
	});

	it("interrupts an active run at its pending bridge call and keeps the worker state", async () => {
		const kernel = createKernel();
		const run = kernel.run({
			cellId: "active-interrupt",
			code: "globalThis.interruptMarker = 1; return await tool.started({ marker: globalThis.interruptMarker })",
			timeoutMs: 2_000,
		});
		const started = await kernel.nextToolCall();
		expect(started).toMatchObject({ toolName: "started", args: { marker: 1 } });

		const handle = await kernel.interrupt("active-stop");

		await expect(run).resolves.toMatchObject({
			ok: false,
			error: { message: expect.stringContaining("active-stop") },
		});
		await expect(handle.stateRetained).resolves.toBe(true);
		await expect(
			kernel.run({ cellId: "fresh", code: "return interruptMarker", timeoutMs: 2_000 }),
		).resolves.toMatchObject({
			ok: true,
			valueRepr: "1",
		});
	});

	it("settles an active run exactly once when close occurs", async () => {
		const kernel = createKernel();
		let settlements = 0;
		const run = kernel
			.run({ cellId: "active-close", code: "return await tool.started({ active: true })", timeoutMs: 2_000 })
			.then((result) => {
				settlements += 1;
				return result;
			});
		await kernel.nextToolCall();

		await kernel.close();

		await expect(run).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("closed") } });
		expect(settlements).toBe(1);
	});

	it("settles active and queued runs exactly once when close occurs", async () => {
		const kernel = createKernel();
		const settlements = new Map<string, number>();
		const observe = (cellId: string, code: string) =>
			kernel.run({ cellId, code, timeoutMs: 2_000 }).then((result) => {
				settlements.set(cellId, (settlements.get(cellId) ?? 0) + 1);
				return result;
			});
		const active = observe("queued-close-active", "return await tool.started({ active: true })");
		const queued = observe("queued-close-waiting", "return 42");
		await kernel.nextToolCall();

		await kernel.close();

		await expect(Promise.all([active, queued])).resolves.toEqual([
			expect.objectContaining({
				ok: false,
				error: expect.objectContaining({ message: expect.stringContaining("closed") }),
			}),
			expect.objectContaining({
				ok: false,
				error: expect.objectContaining({ message: expect.stringContaining("closed") }),
			}),
		]);
		expect(settlements).toEqual(
			new Map(["queued-close-active", "queued-close-waiting"].map((cellId) => [cellId, 1])),
		);
	});

	it("makes close irreversible for run, reset, and interrupt", async () => {
		const kernel = createKernel();
		await kernel.close();

		await expect(kernel.run({ cellId: "closed-run", code: "return 1" })).rejects.toThrow(/closed/i);
		await expect(kernel.reset()).rejects.toThrow(/closed/i);
		await expect(kernel.interrupt()).rejects.toThrow(/closed/i);
	});

	it("does not restart or publish a worker after concurrent interrupt and close", async () => {
		const entry = await createSpawnLoggingWorkerEntry();
		let readyMessages = 0;
		const kernel = createKernel({
			workerEntryUrl: entry.url,
			onMessage: (message) => {
				if (message.type === "ready") readyMessages += 1;
			},
		});
		try {
			const run = kernel.run({
				cellId: "interrupt-close",
				code: "return await tool.started({ active: true })",
				timeoutMs: 2_000,
			});
			await kernel.nextToolCall();

			const interrupt = kernel.interrupt("concurrent-close");
			const close = kernel.close();
			await Promise.allSettled([interrupt, close]);

			await expect(run).resolves.toMatchObject({ ok: false });
			expect(await spawnCount(entry)).toBe(1);
			expect(readyMessages).toBe(1);
		} finally {
			await removeWorkerEntry(entry);
		}
	});

	it("does not restart or publish a worker when close overtakes timeout recovery", async () => {
		vi.useFakeTimers();
		const entry = await createSpawnLoggingWorkerEntry();
		let readyMessages = 0;
		const kernel = createKernel({
			workerEntryUrl: entry.url,
			onMessage: (message) => {
				if (message.type === "ready") readyMessages += 1;
			},
		});
		try {
			const run = kernel.run({
				cellId: "timeout-close",
				code: "return await tool.started({ active: true })",
				timeoutMs: 1_000,
			});
			const queued = kernel.run({ cellId: "timeout-close-queued", code: "return 42", timeoutMs: 1_000 });
			await kernel.nextToolCall();

			vi.advanceTimersByTime(1_000);
			await kernel.close();

			await expect(run).resolves.toMatchObject({
				ok: false,
				error: { message: expect.stringMatching(/timed out/i) },
			});
			await expect(queued).resolves.toMatchObject({
				ok: false,
				error: { message: expect.stringMatching(/closed/i) },
			});
			expect(await spawnCount(entry)).toBe(1);
			expect(readyMessages).toBe(1);
		} finally {
			await removeWorkerEntry(entry);
		}
	});
});
