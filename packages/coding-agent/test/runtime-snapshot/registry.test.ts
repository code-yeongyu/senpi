import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_SNAPSHOT_MARKER } from "../../src/runtime-snapshot/marker.ts";
import { pruneRuntimeSnapshots, UNUSED_SNAPSHOT_GRACE_MS } from "../../src/runtime-snapshot/registry.ts";
import { createFakeInstall, type FakeInstall } from "./fake-install.ts";

const enterModule = fileURLToPath(new URL("../../src/runtime-snapshot/enter.ts", import.meta.url));
const NOW = Date.now();

function oldSnapshot(root: string, name: string, claims: readonly number[], lastUsedMs: number): string {
	const dir = join(root, name);
	mkdirSync(join(dir, "claims"), { recursive: true });
	writeFileSync(join(dir, RUNTIME_SNAPSHOT_MARKER), JSON.stringify({ buildId: name, installPackageDir: "/gone" }));
	for (const pid of claims) writeFileSync(join(dir, "claims", String(pid)), "");
	const at = new Date(lastUsedMs);
	utimesSync(join(dir, RUNTIME_SNAPSHOT_MARKER), at, at);
	return dir;
}

describe("runtime snapshot registry (#2358)", () => {
	const installs: FakeInstall[] = [];
	afterEach(() => {
		while (installs.length) installs.pop()?.cleanup();
	});

	it("deletes only snapshots no live process claims and nobody used within the grace period", () => {
		// Given: pid 1001 is alive, 1002 has exited.
		const install = createFakeInstall();
		installs.push(install);
		const root = join(install.agentDir, "runtime");
		const current = oldSnapshot(root, "current", [], NOW);
		const liveOld = oldSnapshot(root, "live-old", [1001, 1002], NOW - 2 * UNUSED_SNAPSHOT_GRACE_MS);
		const deadOld = oldSnapshot(root, "dead-old", [1002], NOW - 2 * UNUSED_SNAPSHOT_GRACE_MS);
		const deadRecent = oldSnapshot(root, "dead-recent", [1002], NOW - UNUSED_SNAPSHOT_GRACE_MS / 2);
		mkdirSync(join(root, ".tmp-crashed-7"));
		utimesSync(join(root, ".tmp-crashed-7"), new Date(0), new Date(0));
		// When
		pruneRuntimeSnapshots(root, "current", NOW, (pid) => pid === 1001);
		// Then
		expect(existsSync(current)).toBe(true);
		expect(readdirSync(join(liveOld, "claims"))).toEqual(["1001"]);
		expect(existsSync(deadOld)).toBe(false);
		expect(existsSync(deadRecent)).toBe(true);
		expect(readdirSync(join(deadRecent, "claims"))).toEqual([]);
		expect(readdirSync(root).sort()).toEqual(["current", "dead-recent", "live-old"]);
	});

	it("gives concurrent launches of one build a single shared snapshot", async () => {
		// Given
		const install = createFakeInstall();
		installs.push(install);
		const script = `import { prepareRuntimeSnapshot } from ${JSON.stringify(enterModule)};
const decision = await prepareRuntimeSnapshot(${JSON.stringify(install.entryPath)}, ${JSON.stringify(install.packageDir)}, ${JSON.stringify(install.agentDir)});
process.stdout.write(JSON.stringify(decision) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));`;
		const children: ChildProcess[] = [];
		try {
			// When: four launches race through the lock at once and stay running.
			const launches = Array.from({ length: 4 }, async () => {
				const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
					stdio: ["pipe", "pipe", "inherit"],
				});
				children.push(child);
				if (!child.stdout) throw new Error("no stdout");
				const [line] = await once(createInterface({ input: child.stdout }), "line", {
					signal: AbortSignal.timeout(60_000),
				});
				return { pid: child.pid, decision: JSON.parse(String(line)) as { kind: string; snapshotDir?: string } };
			});
			const results = await Promise.all(launches);
			// Then
			const dirs = new Set(results.map((result) => result.decision.snapshotDir));
			expect(results.map((result) => result.decision.kind)).toEqual([
				"hand-off",
				"hand-off",
				"hand-off",
				"hand-off",
			]);
			expect(dirs.size).toBe(1);
			const [snapshotDir] = [...dirs];
			if (!snapshotDir) throw new Error("no snapshot");
			const claims = readdirSync(join(snapshotDir, "claims")).sort();
			expect(claims).toEqual(results.map((result) => String(result.pid)).sort());
			expect(readdirSync(join(install.agentDir, "runtime")).filter((name) => name.startsWith("."))).toEqual([]);
		} finally {
			for (const child of children) {
				const exited = once(child, "exit");
				child.stdin?.end();
				await exited;
			}
		}
	}, 90_000);
});
