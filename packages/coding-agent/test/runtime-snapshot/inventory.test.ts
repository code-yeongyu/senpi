import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { materializeRuntimeSnapshot, type RuntimeManifest } from "../../src/runtime-snapshot/layout.ts";
import { inventoryRuntime } from "./inventory.ts";

// #5816: one 180 s budget covered the snapshot plus both runtimes' four CLI starts each, and timed out on loaded
// receipt hosts. Each phase now has its own budget. Measured on a 14-core Linux receipt host under CPU contention
// (case pinned to one or two cores beside 14-18 CPU burners, host load 62-146; the failing receipts ran at 95-117):
// materialize max 29 s, Node max 134 s, Bun max 128 s, whole case 231-264 s with the old test timing out in 5 of
// 5 runs. Idle: materialize 1 s, each runtime 4-6 s. Each budget is about twice its loaded maximum.
const MATERIALIZE_BUDGET_MS = 60_000;
const RUNTIME_INVENTORY_BUDGET_MS = 270_000;

let state: string | undefined;
let snapshot = "";

beforeAll(async () => {
	// Given: the built release graph, including native packages and the source-only codemode sidecar.
	const packageDir = process.env.SENPI_INVENTORY_PACKAGE ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const manifestPath = join(packageDir, "dist/bundle/runtime-manifest.json");
	expect(existsSync(manifestPath), "Build the CLI before running the runtime inventory").toBe(true);
	const manifest: RuntimeManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	state = mkdtempSync(join(tmpdir(), "senpi-runtime-inventory-"));
	snapshot = join(state, "snapshot");
	await materializeRuntimeSnapshot(packageDir, snapshot, manifest);
}, MATERIALIZE_BUDGET_MS);

afterAll(() => {
	if (state !== undefined) rmSync(state, { recursive: true, force: true });
});

// #2408 / #3083: the real CLI must load its dependency paths from the snapshot, not the install.
it.each(["node", "bun"])(
	"contains every dependency resolved by real %s entry paths",
	(runtime) => {
		// When: the CLI really loads extensions and runs a turn under this runtime.
		const paths = inventoryRuntime(snapshot, join(state ?? "", runtime), runtime);
		// Then: inventoryRuntime enforces existence and containment; SDK resolution must be exercised.
		expect(paths.some((path) => path.replaceAll("\\", "/").includes("/@anthropic-ai/claude-agent-sdk"))).toBe(true);
	},
	RUNTIME_INVENTORY_BUDGET_MS,
);
