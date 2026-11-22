import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { ExtensionTransportOwner } from "../../src/modes/rpc/extension-owner.ts";

it("makes retirement visible across isolates before the detach message arrives", async () => {
	const transport = new ExtensionTransportOwner();
	const owner = transport.capture("binding-a");
	const worker = new Worker(new URL("./rpc-owner-gate.worker.mjs", import.meta.url), {
		execArgv: ["--import", "tsx"],
		workerData: owner.wire,
	});
	try {
		await once(worker, "message", { signal: AbortSignal.timeout(30_000) });
		// Given: a real worker holds the captured capability; no detach message was sent.
		transport.retire();
		const result = once(worker, "message", { signal: AbortSignal.timeout(30_000) });
		worker.postMessage("dispatch");
		// Then: the shared gate prevents dispatch even though the local signal is not yet aborted.
		expect((await result)[0]).toEqual({
			type: "result",
			dispatched: 0,
			aborted: false,
			error: "AbortError",
		});
		const detached = once(worker, "message", { signal: AbortSignal.timeout(30_000) });
		worker.postMessage("detach");
		expect((await detached)[0]).toEqual({ type: "detached", aborted: true });
	} finally {
		await worker.terminate();
	}
}, 60_000);

it("keeps distinct binding gates while preserving the transport incarnation", () => {
	const transport = new ExtensionTransportOwner();
	const a = transport.capture("binding-a");
	const b = transport.capture("binding-b");
	expect(a.context.ownerId).toBe(b.context.ownerId);
	expect(transport.capture("binding-a")).toBe(a);
	transport.retireBinding("binding-a");
	expect(() => a.context.admit(() => 1)).toThrow();
	expect(b.context.admit(() => 2)).toBe(2);
	// A retired binding cannot be revived by asking for it again.
	expect(() => transport.capture("binding-a").context.admit(() => 3)).toThrow();
	transport.retire();
	expect(() => b.context.admit(() => 4)).toThrow();
	expect(() => transport.capture("new-binding")).toThrow();
});
