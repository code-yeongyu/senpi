import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCliMainPath } from "../../src/modes/rpc/host-lifecycle.ts";
import { prepareRuntimeSnapshot } from "../../src/runtime-snapshot/enter.ts";
import { createFakeInstall, type FakeInstall, isInside } from "./fake-install.ts";

// #2409: the RPC host supervisor and its children re-enter the CLI through this path. From a
// runtime snapshot it must stay inside the snapshot, or an upgrade changes what a running host runs.
describe("host entry of a runtime snapshot launch (#2409)", () => {
	const installs: FakeInstall[] = [];
	afterEach(() => {
		while (installs.length) installs.pop()?.cleanup();
	});

	it("re-enters the snapshot's own bundled CLI, not the unbundled tree the package also ships", async () => {
		// Given: a bundled launch handed off to its snapshot; the host module is a bundle chunk
		const install = createFakeInstall();
		installs.push(install);
		const decision = await prepareRuntimeSnapshot(install.entryPath, install.packageDir, install.agentDir);
		if (decision.kind !== "hand-off") throw new Error(`expected a hand-off, got ${decision.kind}`);
		const chunk = join(decision.snapshotDir, "dist/bundle/chunks/host-lifecycle.js");
		// When
		const entry = resolveCliMainPath(chunk, true);
		// Then
		expect(entry).toBe(join(decision.snapshotDir, "dist/bundle/cli.js"));
		expect(entry).toBe(fileURLToPath(decision.entryUrl));
		expect(isInside(entry, decision.snapshotDir)).toBe(true);
	});

	it("keeps the unbundled tree on its sibling cli-main", () => {
		// Given
		const install = createFakeInstall();
		installs.push(install);
		const module = join(install.packageDir, "dist/modes/rpc/host-lifecycle.js");
		// When / Then
		expect(resolveCliMainPath(module, false)).toBe(join(install.packageDir, "dist/cli-main.js"));
	});
});
