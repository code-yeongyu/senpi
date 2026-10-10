import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { materializeRuntimeSnapshot, type RuntimeManifest } from "../../src/runtime-snapshot/layout.ts";
import { inventoryRuntime } from "./inventory.ts";

// #2408 / #3083: the real CLI must load its dependency paths from the snapshot, not the install.
it("contains every dependency resolved by real Node and Bun entry paths", async () => {
	// Given: the built release graph, including native packages and the source-only codemode sidecar.
	const packageDir = process.env.SENPI_INVENTORY_PACKAGE ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const manifestPath = join(packageDir, "dist/bundle/runtime-manifest.json");
	expect(existsSync(manifestPath), "Build the CLI before running the runtime inventory").toBe(true);
	const manifest: RuntimeManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const state = mkdtempSync(join(tmpdir(), "senpi-runtime-inventory-"));
	try {
		const snapshot = join(state, "snapshot");
		// When: the snapshot uses the real materializer, then the CLI really loads extensions and runs a turn.
		await materializeRuntimeSnapshot(packageDir, snapshot, manifest);
		for (const runtime of ["node", "bun"]) {
			const paths = inventoryRuntime(snapshot, join(state, runtime), runtime);
			// Then: not a frozen package list or static scan; newly resolved paths must exist too.
			for (const path of paths) expect(existsSync(path), path).toBe(true);
			expect(paths.some((path) => path.replaceAll("\\", "/").includes("/@anthropic-ai/claude-agent-sdk"))).toBe(
				true,
			);
		}
	} finally {
		rmSync(state, { recursive: true, force: true });
	}
}, 180_000);
