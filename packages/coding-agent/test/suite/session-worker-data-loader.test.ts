import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { loadExtensions } from "../../src/core/extensions/loader.ts";
import { sessionWorkerDataRegistry } from "../../src/modes/rpc/session-worker-data.ts";

// senpi#4728 review LOW 4: an extension reaches the host's registry through the public subpath.
it("lets a loaded extension provide session worker data the host issues", async () => {
	// Given: an extension module that provides a value through the public subpath at load time.
	const dir = await mkdtemp(join(tmpdir(), "senpi-worker-data-ext-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const name = `loader-probe-${process.pid}-${Date.now()}`;
	const entry = join(dir, "provider.ts");
	await writeFile(
		entry,
		`import { provideSessionWorkerData, sessionWorkerData } from "@code-yeongyu/senpi/session-worker-data";
provideSessionWorkerData(${JSON.stringify(name)}, () => ({ value: "from-extension" }));
export default function (pi) {
	pi.rpc.handle("probe.inside", () => ({ inside: sessionWorkerData(${JSON.stringify(name)}) ?? null }));
}`,
	);

	// When: the real loader imports it and the host issues one session worker's data.
	const loaded = await loadExtensions([entry], dir);
	const { issued } = sessionWorkerDataRegistry.spawn(() => undefined);
	onTestFinished(() => issued.dispose());

	// Then: the provider registered in the host's own registry, and outside a worker the reader is empty.
	expect(loaded.errors).toEqual([]);
	expect(issued.extensionData[name]).toBe("from-extension");
	expect(await loaded.extensions[0]?.rpcHandlers?.get("probe.inside")?.(undefined)).toEqual({ inside: null });
});
