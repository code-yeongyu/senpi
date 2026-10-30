import { once } from "node:events";
import { MessageChannel, type MessagePort, type Transferable, Worker } from "node:worker_threads";
import { expect, it, onTestFinished } from "vitest";
import { SessionWorkerDataRegistry } from "../../src/modes/rpc/session-worker-data.ts";

// senpi#4728: per-session-Worker data reaches each real Worker thread on its own, never shared or broadcast.
const probe = new URL("./session-worker-data.worker.mjs", import.meta.url);

function startProbe(options: { workerData?: unknown; transferList?: Transferable[] } = {}): Worker {
	const worker = new Worker(probe, { execArgv: ["--import", "tsx"], ...options });
	onTestFinished(async () => {
		await worker.terminate();
	});
	return worker;
}

async function ready(worker: Worker): Promise<{ type: string; label: string | null; hasPort: boolean }> {
	const [message] = await once(worker, "message", { signal: AbortSignal.timeout(120_000) });
	return message;
}

it("issues each session worker its own value and port, and neither sees the other's traffic", async () => {
	// Given: a provider that makes one channel per worker and keeps the host side.
	const registry = new SessionWorkerDataRegistry();
	const hostSides: MessagePort[] = [];
	let issued = 0;
	registry.provide("probe.label", () => ({ value: `worker-${++issued}` }));
	registry.provide("probe.port", () => {
		const channel = new MessageChannel();
		hostSides.push(channel.port1);
		return { value: channel.port2, transfer: [channel.port2], dispose: () => channel.port1.close() };
	});

	// When: two session workers spawn and each host side sends a message.
	const spawn = () =>
		registry.spawn((data) =>
			startProbe({
				workerData: { extensionData: data.extensionData },
				transferList: [...data.transfer],
			}),
		).result;
	const first = spawn();
	const firstReady = ready(first);
	const second = spawn();
	const secondReady = ready(second);
	expect(await firstReady).toEqual({ type: "ready", label: "worker-1", hasPort: true });
	expect(await secondReady).toEqual({ type: "ready", label: "worker-2", hasPort: true });
	const [a, b] = hostSides;
	if (!a || !b) throw new Error("both host sides were not issued");
	const seenByB: unknown[] = [];
	b.on("message", (message) => seenByB.push(message));
	const replyA = once(a, "message", { signal: AbortSignal.timeout(120_000) });
	a.postMessage("for-a");
	const replyB = once(b, "message", { signal: AbortSignal.timeout(120_000) });
	b.postMessage("for-b");

	// Then: each reply comes from its own worker and B's port never carries A's traffic.
	expect((await replyA)[0]).toEqual({ echo: "for-a", label: "worker-1" });
	expect((await replyB)[0]).toEqual({ echo: "for-b", label: "worker-2" });
	expect(seenByB).toEqual([{ echo: "for-b", label: "worker-2" }]);
	for (const side of hostSides) side.close();
}, 300_000);

it("gives a worker spawned outside the session registry nothing", async () => {
	// Given: an eval or tool worker created with its own workerData.
	const worker = startProbe({ workerData: { kernel: "js" } });

	// Then: no provided value is visible to it.
	expect(await ready(worker)).toEqual({ type: "ready", label: null, hasPort: false });
}, 300_000);

it("disposes a worker's grants on exit and when its construction throws", async () => {
	// Given: a provider that records disposals.
	const registry = new SessionWorkerDataRegistry();
	const disposed: string[] = [];
	let issued = 0;
	registry.provide("probe.label", () => {
		const label = `worker-${++issued}`;
		return { value: label, dispose: () => disposed.push(label) };
	});

	// When: one spawn throws during construction and another worker exits.
	expect(() =>
		registry.spawn(() => {
			throw new Error("construction failed");
		}),
	).toThrow("construction failed");
	const { result: worker, issued: data } = registry.spawn((grant) =>
		startProbe({ workerData: { extensionData: grant.extensionData } }),
	);
	// The probe exits on its own after "ready"; Node drains that message and emits "exit" in one callback,
	// so a listener added after awaiting "ready" can miss the exit. Attach it before any await.
	worker.once("exit", () => data.dispose());
	await ready(worker);
	await worker.terminate();

	// Then: each grant was disposed exactly once.
	expect(disposed).toEqual(["worker-1", "worker-2"]);
}, 300_000);

it("refuses a provider after the first session worker and a duplicate name", () => {
	// Given: one provider and a first spawn.
	const registry = new SessionWorkerDataRegistry();
	registry.provide("probe.label", () => ({ value: "x" }));

	// Then: a duplicate name throws, and so does any provider after the first spawn.
	expect(() => registry.provide("probe.label", () => ({ value: "y" }))).toThrow("already provided");
	registry.spawn(() => undefined).issued.dispose();
	expect(() => registry.provide("probe.late", () => ({ value: "z" }))).toThrow("after the first session worker");
});
