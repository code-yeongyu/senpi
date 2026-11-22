import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { createHarness, type Harness } from "./harness.ts";
import { createMovedLayout, type MovedLayout, runTool } from "./moved-path-guard-fixtures.ts";

// code-yeongyu/senpi#2898 review M1: the per-call guard runs on the session's event loop, so it must never resolve
// a path with synchronous I/O (a wedged mount would freeze the host), and it examines a bounded number of paths.

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn(actual.existsSync),
		statSync: vi.fn(actual.statSync),
		readFileSync: vi.fn(actual.readFileSync),
		appendFileSync: vi.fn(actual.appendFileSync),
		realpathSync: Object.assign(vi.fn(actual.realpathSync), { native: actual.realpathSync.native }),
	};
});

const syncProbes = () => [fs.existsSync, fs.statSync, fs.readFileSync, fs.realpathSync] as const;

function syncCallsUnder(root: string): string[] {
	return syncProbes().flatMap((probe) =>
		vi
			.mocked(probe)
			.mock.calls.map((call) => String(call[0]))
			.filter((path) => path.startsWith(root)),
	);
}

describe("moved-path-guard I/O on the session loop (#2898)", () => {
	const layouts: MovedLayout[] = [];
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (layouts.length > 0) layouts.pop()?.cleanup();
	});

	it("checks shell commands and file writes without synchronous path I/O", async () => {
		const guard = builtinExtensions.find((entry) => entry.id === "moved-path-guard");
		if (!guard) throw new Error("moved-path-guard is not registered");
		const layout = createMovedLayout();
		layouts.push(layout);
		const harness = await createHarness({
			cwd: layout.home,
			extensionFactories: [guard.factory],
			initialActiveToolNames: ["bash", "write"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		for (const probe of syncProbes()) vi.mocked(probe).mockClear();

		const bash = await runTool(harness, "bash", { command: `mkdir -p ${layout.oldWorktree}/x` });
		const write = await runTool(harness, "write", { path: join(layout.oldSessions, "s.jsonl"), content: "x" });

		expect([bash.outcome, write.outcome]).toEqual(["blocked", "error"]);
		expect(syncCallsUnder(layout.home)).toEqual([]);
	});

	// Re-review L7: reporting an ignored breadcrumb from a tool call writes nothing synchronously.
	it("reports an ignored breadcrumb without a synchronous log write", async () => {
		const guard = builtinExtensions.find((entry) => entry.id === "moved-path-guard");
		if (!guard) throw new Error("moved-path-guard is not registered");
		const layout = createMovedLayout({ schemaVersion: 2 });
		layouts.push(layout);
		const harness = await createHarness({
			cwd: layout.home,
			extensionFactories: [guard.factory],
			initialActiveToolNames: ["bash"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		vi.mocked(fs.appendFileSync).mockClear();

		const result = await runTool(harness, "bash", { command: `mkdir -p ${layout.oldWorktree}/x` });

		expect(result.outcome).toBe("ok");
		expect(vi.mocked(fs.appendFileSync)).not.toHaveBeenCalled();
	});

	// Re-review M3: past the per-call bound the guard still refuses a literal old path, by text, without filesystem work.
	it("refuses a literal old path behind more decoy paths than one call examines", async () => {
		const guard = builtinExtensions.find((entry) => entry.id === "moved-path-guard");
		if (!guard) throw new Error("moved-path-guard is not registered");
		const layout = createMovedLayout();
		layouts.push(layout);
		const harness = await createHarness({
			cwd: layout.home,
			extensionFactories: [guard.factory],
			initialActiveToolNames: ["bash"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		vi.stubEnv("HOME", layout.home);
		vi.stubEnv("USERPROFILE", layout.home);
		const decoys = Array.from({ length: 500 }, (_, index) => `/decoy/${index}`).join(" ");

		const result = await runTool(harness, "bash", { command: `touch ${decoys} ${layout.oldWorktree}/late.txt` });

		expect(result.outcome).toBe("blocked");
		expect(result.text).toContain(layout.newWorktree);
	});
});
