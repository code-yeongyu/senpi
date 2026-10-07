import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearExtensionCache, loadExtensions, loadExtensionsCached } from "../../../src/core/extensions/loader.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";

interface TestState {
	moduleLoads?: number;
	factoryRuns?: number;
}

function state(): TestState {
	const global = globalThis as typeof globalThis & { __extensionFactoryCacheTest?: TestState };
	if (!global.__extensionFactoryCacheTest) {
		global.__extensionFactoryCacheTest = {};
	}
	return global.__extensionFactoryCacheTest;
}

function resetState(): void {
	delete (globalThis as typeof globalThis & { __extensionFactoryCacheTest?: TestState }).__extensionFactoryCacheTest;
}

function writeCountingExtension(filePath: string, padding = "a"): void {
	writeFileSync(
		filePath,
		`
const state = (globalThis.__extensionFactoryCacheTest ??= {});
state.moduleLoads = (state.moduleLoads ?? 0) + 1;
export const padding = ${JSON.stringify(padding)};

export default function () {
	state.factoryRuns = (state.factoryRuns ?? 0) + 1;
}
`,
		"utf-8",
	);
	const future = new Date(Date.now() + 2_000);
	utimesSync(filePath, future, future);
}

/**
 * These run on the jiti importer (vitest workers are Node), which cannot report the files it
 * compiled and is therefore never cached: freshness wins over reuse where staleness cannot be
 * detected. The Bun importer's caching contract - one module generation per source version - is
 * pinned in `test/extensions/extension-module-graph-reuse.test.ts`, which drives a real Bun process.
 */
describe("extension factory lifecycle on an importer that cannot report its sources", () => {
	const roots: string[] = [];

	function fixture(name: string) {
		const root = join(tmpdir(), `pi-extension-cache-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		roots.push(root);
		return { root, cwd, agentDir };
	}

	beforeEach(() => {
		resetState();
		clearExtensionCache();
	});

	afterEach(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root && existsSync(root)) {
				rmSync(root, { recursive: true, force: true });
			}
		}
		resetState();
		clearExtensionCache();
	});

	it("gives every load its own extension instance and runtime", async () => {
		const { root, cwd } = fixture("same-cwd");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		const first = await loadExtensionsCached([extensionPath], cwd);
		const second = await loadExtensionsCached([extensionPath], cwd);

		expect(state().factoryRuns).toBe(2);
		expect(first.extensions[0]).not.toBe(second.extensions[0]);
		expect(first.runtime).not.toBe(second.runtime);
	});

	it("re-evaluates rather than serving a factory it cannot verify", async () => {
		const { root, cwd } = fixture("direct");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		await loadExtensions([extensionPath], cwd);
		await loadExtensions([extensionPath], cwd);
		await loadExtensionsCached([extensionPath], cwd);

		expect(state().moduleLoads).toBe(3);
		expect(state().factoryRuns).toBe(3);
	});

	it("picks up an edited extension on reload", async () => {
		const { cwd, agentDir } = fixture("reload");
		const extensionDir = join(agentDir, "extensions");
		mkdirSync(extensionDir, { recursive: true });
		writeCountingExtension(join(extensionDir, "counting.ts"));
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});

		await loader.reload();
		await loader.reload();

		expect(state().moduleLoads).toBe(2);
		expect(state().factoryRuns).toBe(2);

		writeCountingExtension(join(extensionDir, "counting.ts"), "bb");
		await loader.reload();

		expect(state().moduleLoads).toBe(3);
		expect(state().factoryRuns).toBe(3);
	});

	it("does not let one cwd serve another cwd a cached factory", async () => {
		const { root } = fixture("cross-cwd");
		const firstCwd = join(root, "first");
		const secondCwd = join(root, "second");
		mkdirSync(firstCwd, { recursive: true });
		mkdirSync(secondCwd, { recursive: true });
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		await loadExtensionsCached([extensionPath], firstCwd);
		await loadExtensionsCached([extensionPath], secondCwd);
		await loadExtensionsCached([extensionPath], secondCwd);

		expect(state().moduleLoads).toBe(3);
		expect(state().factoryRuns).toBe(3);
	});
});
