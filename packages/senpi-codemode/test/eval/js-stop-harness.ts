// Shared helpers for the JS kernel stop contracts: a kernel on a spawn-logging worker, a cell that has provably
// started, a server that never answers, and the checks that a stop kept the VM and ended the stopped cell's work.
import { createServer, type Server } from "node:http";
import { afterEach, expect } from "vitest";
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";

export { spawnCount } from "./js-worker-spawn-log.ts";

import {
	createSpawnLoggingWorkerEntry,
	removeWorkerEntry,
	type SpawnLoggingWorkerEntry,
	spawnCount,
} from "./js-worker-spawn-log.ts";

const kernels = new Set<JavaScriptKernel>();
const entries = new Set<SpawnLoggingWorkerEntry>();
const servers = new Set<Server>();

/** Registers per-test cleanup of every kernel, worker entry and server the helpers create. */
export function registerStopHarnessCleanup(): void {
	afterEach(async () => {
		await Promise.all([...kernels].map(async (kernel) => await kernel.close()));
		await Promise.all([...entries].map(async (entry) => await removeWorkerEntry(entry)));
		for (const server of servers) server.closeAllConnections();
		await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
		kernels.clear();
		entries.clear();
		servers.clear();
	});
}

export async function createKernel(): Promise<{
	readonly kernel: JavaScriptKernel;
	readonly entry: SpawnLoggingWorkerEntry;
}> {
	const entry = await createSpawnLoggingWorkerEntry();
	entries.add(entry);
	const kernel = new JavaScriptKernel({
		sessionId: `stop-keeps-state-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		parallelPoolWidth: 2,
		workerEntryUrl: entry.url,
	});
	kernels.add(kernel);
	return { kernel, entry };
}

export async function startedCell(
	kernel: JavaScriptKernel,
	cellId: string,
	code: string,
	onText: (text: string) => void = () => {},
) {
	const run = kernel.run({
		cellId,
		code: `await tool.started({});\n${code}`,
		timeoutMs: 60_000,
		onMessage: (message) => {
			if (message.type === "text") onText(message.data);
		},
	});
	const call = await kernel.nextToolCall();
	kernel.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value: null });
	return { run };
}

export async function silentServer(): Promise<{
	readonly url: string;
	readonly requested: Promise<void>;
	readonly aborted: Promise<void>;
}> {
	const requested = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const server = createServer((request) => {
		request.once("close", () => aborted.resolve());
		requested.resolve();
	});
	servers.add(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("the probe server is not bound");
	return {
		url: `http://127.0.0.1:${address.port}/`,
		requested: requested.promise,
		aborted: aborted.promise,
	};
}

/** Stops the cell, proves the kernel kept its state on the same worker, and returns the next cell's stderr. */
export async function stopAndExpectStateKept(
	kernel: JavaScriptKernel,
	entry: SpawnLoggingWorkerEntry,
	run: ReturnType<JavaScriptKernel["run"]>,
): Promise<string> {
	const handle = await kernel.interrupt("user-stop");
	await expect(run).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("user-stop") } });
	await expect(handle.stateRetained).resolves.toBe(true);
	const stderr: string[] = [];
	await expect(
		kernel.run({
			cellId: "after-stop",
			code: "await new Promise((r) => setTimeout(r, 0)); return keep",
			timeoutMs: 5_000,
			onMessage: (message) => {
				if (message.type === "text" && message.stream === "stderr") stderr.push(message.data);
			},
		}),
	).resolves.toMatchObject({ ok: true, valueRepr: "41" });
	expect(await spawnCount(entry)).toBe(1);
	return stderr.join("");
}

/** After a stop, a stopped loop has stopped ticking: two reads 150 ms apart see the same count. */
export async function expectLoopStopped(kernel: JavaScriptKernel): Promise<void> {
	const first = await kernel.run({ cellId: "ticks-a", code: "return ticks", timeoutMs: 5_000 });
	const second = await kernel.run({
		cellId: "ticks-b",
		code: "await new Promise((r) => setTimeout(r, 150)); return ticks",
		timeoutMs: 5_000,
	});
	expect(second).toMatchObject({ ok: true, valueRepr: first.ok ? first.valueRepr : "unreachable" });
}
