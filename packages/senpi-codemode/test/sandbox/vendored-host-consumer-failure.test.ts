import { afterEach, describe, expect, it, vi } from "vitest";

let scriptDone = Promise.withResolvers<void>();

// A pass-through Worker that reports when the host is handed the script's "done" message. Its listener is
// registered before the host's, so by the time a consumer awaiting scriptDone resumes, the host has finished.
vi.mock("node:worker_threads", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:worker_threads")>();
	class ObservedWorker extends original.Worker {
		constructor(...args: ConstructorParameters<typeof original.Worker>) {
			super(...args);
			this.on("message", (message: unknown) => {
				if (typeof message === "object" && message !== null && "type" in message && message.type === "done") {
					scriptDone.resolve();
				}
			});
		}
	}
	return { ...original, Worker: ObservedWorker };
});

const { CodemodeSandbox } = await import("../../src/kernels/sandbox/vendor/pi-codemode/runtime/host.ts");

const sandboxes: InstanceType<typeof CodemodeSandbox>[] = [];

afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map(async (sandbox) => await sandbox.close()));
	scriptDone = Promise.withResolvers<void>();
});

describe("Given a streaming run whose script has already returned", () => {
	it("When the consumer throws on a frame that drains afterwards, then the run settles as failed instead of ok", async () => {
		let calls = 0;
		const sandbox = new CodemodeSandbox({
			output: "stream",
			timeoutMs: 60_000,
			onOutputFrame: async () => {
				calls += 1;
				await scriptDone.promise;
				throw new Error("consumer broke");
			},
		});
		sandboxes.push(sandbox);

		const result = await sandbox.execute('for (let i = 0; i < 5; i++) text("0123456789abcdef"); return 7');

		expect(result).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: "Output consumer failed: consumer broke" },
		});
		expect(calls).toBe(1);
	}, 30_000);

	it("When an abort arrives after its only frame was consumed, then the run keeps its value and store writes", async () => {
		const controller = new AbortController();
		const frames: string[] = [];
		const sandbox = new CodemodeSandbox({
			output: "stream",
			timeoutMs: 60_000,
			onOutputFrame: (frame) => {
				frames.push(frame.chunk);
			},
		});
		sandboxes.push(sandbox);
		void scriptDone.promise.then(() => controller.abort());

		const result = await sandbox.execute('text("done"); store("k", 1); return 7', { signal: controller.signal });

		expect(frames.join("")).toBe("done");
		expect(result).toMatchObject({ ok: true, value: 7, storeWrites: { set: { k: 1 } } });
	}, 30_000);
});
