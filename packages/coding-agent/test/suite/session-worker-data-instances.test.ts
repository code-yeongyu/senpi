import { expect, it, vi } from "vitest";

type WorkerDataModule = typeof import("../../src/modes/rpc/session-worker-data.ts");

// senpi#4728: the registry state is process-wide (same in-process trust boundary as the extensions that
// call it), so a second module instance must see the same providers and the same seal.
async function freshInstance(): Promise<WorkerDataModule> {
	vi.resetModules();
	return import("../../src/modes/rpc/session-worker-data.ts");
}

it("seals the shared registry for every module instance once the first session worker spawns", async () => {
	// Given: two distinct instances of the module, as a host import and an extension loader import produce.
	const host = await freshInstance();
	const extension = await freshInstance();
	expect(extension.SessionWorkerDataRegistry).not.toBe(host.SessionWorkerDataRegistry);
	const name = `instances-probe-${process.pid}`;
	extension.provideSessionWorkerData(name, () => ({ value: "shared" }));

	// When: the host instance spawns the first session worker.
	const { issued } = host.sessionWorkerDataRegistry.spawn(() => undefined);
	issued.dispose();

	// Then: it issued the other instance's provider, and neither instance can provide afterwards.
	expect(issued.extensionData[name]).toBe("shared");
	expect(() => extension.provideSessionWorkerData(`${name}-late`, () => ({ value: 1 }))).toThrow(
		"after the first session worker",
	);
	expect(() => host.provideSessionWorkerData(`${name}-late`, () => ({ value: 1 }))).toThrow(
		"after the first session worker",
	);
});
