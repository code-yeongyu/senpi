// senpi#3566 todo 4: extension code's child_process (named import, default import, transitive CJS require) resolves to
// the per-process module: real on the server, gated in a tool child. Real Bun extension importer in a bun process.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const probe = resolve(import.meta.dirname, "../fixtures/gated-import-probe.ts");
const bunAvailable = spawnSync("bun", ["--version"]).status === 0;

function runProbe(role: "server" | "child") {
	const run = spawnSync("bun", [probe, role], { encoding: "utf8", timeout: 60_000 });
	expect(run.status, run.stderr).toBe(0);
	return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as {
		statuses: number[];
		calls: string[];
		nested: string;
	};
}

describe.skipIf(!bunAvailable)("extension child_process redirect", () => {
	it("serves the real module on the server: every import form works and nothing is gated", () => {
		expect(runProbe("server")).toEqual({ statuses: [0, 0, 0], calls: [], nested: "started" });
	}, 90_000);

	it("routes named, default and transitive CJS imports through the installed module in a tool child", () => {
		expect(runProbe("child")).toEqual({
			statuses: [0, 0, 0],
			calls: ["gated", "gated", "gated"],
			nested: "tool_child_nested_worker_refused",
		});
	}, 90_000);
});
