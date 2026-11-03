import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_SNAPSHOT_MARKER } from "../../../src/runtime-snapshot/marker.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const bundledSupervisor = new URL("../../../dist/bundle/host-supervisor.js", import.meta.url).pathname;
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function snapshotWithSupervisor(): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-snapshot-claim-"));
	roots.push(root);
	const snapshot = join(root, "runtime", "build-install");
	mkdirSync(join(snapshot, "dist", "bundle"), { recursive: true });
	writeFileSync(join(snapshot, "package.json"), JSON.stringify({ type: "module" }));
	writeFileSync(
		join(snapshot, RUNTIME_SNAPSHOT_MARKER),
		JSON.stringify({ buildId: "build", installPackageDir: join(root, "install") }),
	);
	copyFileSync(bundledSupervisor, join(snapshot, "dist", "bundle", "host-supervisor.js"));
	return snapshot;
}

// senpi#3743 review: the lean supervisor must still claim the runtime snapshot it runs from, as cli.js did,
// or a prune by a later upgrade can remove it while the supervisor still respawns its host through it.
describe("bundled supervisor program and its runtime snapshot", () => {
	it("claims the snapshot it runs from with its own pid", () => {
		const snapshot = snapshotWithSupervisor();
		const run = spawnSync(
			process.execPath,
			[join(snapshot, "dist", "bundle", "host-supervisor.js"), "--internal-rpc-host-supervisor"],
			{
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		expect(run.status, run.stderr).toBe(2);
		expect(existsSync(join(snapshot, "claims", String(run.pid)))).toBe(true);
	});
});
