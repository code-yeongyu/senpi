import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createSnapshotFileCopier, type SnapshotFileCopier } from "../../src/runtime-snapshot/file-copier.ts";
import { materializeRuntimeSnapshot, type RuntimeManifest } from "../../src/runtime-snapshot/layout.ts";
import { inventoryRuntime } from "./inventory.ts";

// #5816: one 180 s budget covered the snapshot plus both runtimes' four CLI starts each, and timed out on loaded
// receipt hosts. Each runtime now has its own budget. Measured on a 14-core Linux receipt host under CPU contention
// (case pinned to one or two cores beside 14-18 CPU burners, host load 62-146; the failing receipts ran at 95-117):
// Node max 134 s, Bun max 128 s, whole case 231-264 s with the old test timing out in 5 of 5 runs. Idle: each
// runtime 4-6 s. The budget is about twice the loaded maximum.
const RUNTIME_INVENTORY_BUDGET_MS = 270_000;

// The snapshot is the whole dependency closure, because the cases check that nothing the CLI loads is missing
// from it: 14,676 files in 286 packages at f4dc3acc33. Its wall time follows host contention, not the change under
// test: 3-4 s idle, 26 s under a 4% CPU quota, and past a fixed 60 s hook budget on loaded receipt hosts. Planning
// the closure and removing it are synchronous, so a vitest deadline could only fail them after they had finished.
// The hook is therefore bounded by progress instead of wall time: it fails when no file copy finishes for
// COPY_STALL_MS. The longest gap between two finished copies measured 0.29-0.46 s, idle and under the 4% quota;
// 30 s is about 65 times that.
const COPY_STALL_MS = 30_000;
const STALL_CHECK_MS = 1_000;
const NO_WALL_CLOCK_BOUND = 0;

let state: string | undefined;
let snapshot = "";

/** Materializes the snapshot and fails only when its copy stops making progress. */
async function materializeWithProgressBound(
	packageDir: string,
	target: string,
	manifest: RuntimeManifest,
): Promise<void> {
	const copier = createSnapshotFileCopier();
	let lastProgress = performance.now();
	let finished = 0;
	const tracked: SnapshotFileCopier = {
		get mode() {
			return copier.mode;
		},
		async copy(source, destination) {
			lastProgress = performance.now();
			await copier.copy(source, destination);
			finished++;
			lastProgress = performance.now();
		},
	};
	let watchdog: ReturnType<typeof setInterval> | undefined;
	const stalled = new Promise<never>((_, reject) => {
		watchdog = setInterval(() => {
			// Checked after the poll phase, so copies that finished while this process waited for a CPU count first.
			setImmediate(() => {
				const idleMs = performance.now() - lastProgress;
				if (idleMs > COPY_STALL_MS) {
					reject(
						new Error(
							`runtime snapshot copy made no progress for ${Math.round(idleMs)} ms after ${finished} files`,
						),
					);
				}
			});
		}, STALL_CHECK_MS);
	});
	try {
		await Promise.race([materializeRuntimeSnapshot(packageDir, target, manifest, tracked), stalled]);
	} finally {
		clearInterval(watchdog);
	}
}

beforeAll(async () => {
	// Given: the built release graph, including native packages and the source-only codemode sidecar.
	const packageDir = process.env.SENPI_INVENTORY_PACKAGE ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const manifestPath = join(packageDir, "dist/bundle/runtime-manifest.json");
	expect(existsSync(manifestPath), "Build the CLI before running the runtime inventory").toBe(true);
	const manifest: RuntimeManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	state = mkdtempSync(join(tmpdir(), "senpi-runtime-inventory-"));
	snapshot = join(state, "snapshot");
	await materializeWithProgressBound(packageDir, snapshot, manifest);
}, NO_WALL_CLOCK_BOUND);

afterAll(() => {
	if (state !== undefined) rmSync(state, { recursive: true, force: true });
}, NO_WALL_CLOCK_BOUND);

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
