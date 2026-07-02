import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearExtensionCache, loadExtensionsCached } from "../../src/core/extensions/loader.ts";

interface LoaderMultiCwdState {
	moduleLoads: Record<string, number>;
	factoryRuns: Record<string, number>;
	blockNextImport?: Promise<void>;
	importStarted?: () => void;
}

declare global {
	var __extensionLoaderMultiCwdTest: LoaderMultiCwdState | undefined;
}

function state(): LoaderMultiCwdState {
	globalThis.__extensionLoaderMultiCwdTest ??= {
		moduleLoads: {},
		factoryRuns: {},
	};
	return globalThis.__extensionLoaderMultiCwdTest;
}

function resetState(): void {
	globalThis.__extensionLoaderMultiCwdTest = undefined;
}

function writeCountingExtension(filePath: string, label: string): void {
	writeFileSync(
		filePath,
		`
const state = (globalThis.__extensionLoaderMultiCwdTest ??= { moduleLoads: {}, factoryRuns: {} });
state.moduleLoads[${JSON.stringify(label)}] = (state.moduleLoads[${JSON.stringify(label)}] ?? 0) + 1;

export default function () {
	state.factoryRuns[${JSON.stringify(label)}] = (state.factoryRuns[${JSON.stringify(label)}] ?? 0) + 1;
}
`,
		"utf-8",
	);
}

function writeBlockingCountingExtension(filePath: string, label: string): void {
	writeFileSync(
		filePath,
		`
const state = (globalThis.__extensionLoaderMultiCwdTest ??= { moduleLoads: {}, factoryRuns: {} });
state.moduleLoads[${JSON.stringify(label)}] = (state.moduleLoads[${JSON.stringify(label)}] ?? 0) + 1;
const block = state.blockNextImport;
if (block) {
	state.blockNextImport = undefined;
	state.importStarted?.();
	await block;
}

export default function () {
	state.factoryRuns[${JSON.stringify(label)}] = (state.factoryRuns[${JSON.stringify(label)}] ?? 0) + 1;
}
`,
		"utf-8",
	);
}

describe("extension loader multi-cwd cache", () => {
	const roots: string[] = [];

	function fixture(name: string): string {
		const root = mkdtempSync(join(tmpdir(), `pi-extension-loader-multi-cwd-${name}-`));
		roots.push(root);
		return root;
	}

	function cwd(root: string, name: string): string {
		const cwdPath = join(root, name);
		mkdirSync(cwdPath, { recursive: true });
		return cwdPath;
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

	it("keeps cwd A warm when loading cwd B then cwd A again", async () => {
		// Given: one extension loaded from two distinct session cwd values.
		const root = fixture("aba");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath, "shared");
		const cwdA = cwd(root, "cwd-a");
		const cwdB = cwd(root, "cwd-b");

		// When: A loads, then B loads, then A loads again.
		await loadExtensionsCached([extensionPath], cwdA);
		await loadExtensionsCached([extensionPath], cwdB);
		await loadExtensionsCached([extensionPath], cwdA);

		// Then: A reused its compiled factory instead of recompiling after B.
		expect(state().moduleLoads.shared).toBe(2);
		expect(state().factoryRuns.shared).toBe(3);
	});

	it("evicts the least-recently-used cwd when the 17th cwd is cached", async () => {
		// Given: sixteen cwd cache entries where cwd-0 is refreshed after the initial fill.
		const root = fixture("lru");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath, "lru");
		const cwds = Array.from({ length: 17 }, (_unused, index) => cwd(root, `cwd-${index}`));
		for (const cwdPath of cwds.slice(0, 16)) {
			await loadExtensionsCached([extensionPath], cwdPath);
		}
		await loadExtensionsCached([extensionPath], cwds[0]);

		// When: the 17th cwd is loaded and the refreshed cwd-0 is loaded again.
		await loadExtensionsCached([extensionPath], cwds[16]);
		await loadExtensionsCached([extensionPath], cwds[0]);

		// Then: cwd-0 stayed warm, while cwd-1 was the LRU entry and recompiles.
		expect(state().moduleLoads.lru).toBe(17);
		await loadExtensionsCached([extensionPath], cwds[1]);
		expect(state().moduleLoads.lru).toBe(18);
		expect(state().factoryRuns.lru).toBe(20);
	});

	it("bumps generation for one cwd without invalidating another cwd", async () => {
		// Given: cwd A starts compiling an extension while cwd B creates a separate cache generation.
		const root = fixture("generation");
		const cwdA = cwd(root, "cwd-a");
		const cwdB = cwd(root, "cwd-b");
		const extensionA = join(root, "a.ts");
		const extensionB = join(root, "b.ts");
		writeBlockingCountingExtension(extensionA, "a");
		writeCountingExtension(extensionB, "b");
		let unblockImport: () => void = () => {};
		const importBlock = new Promise<void>((resolve) => {
			unblockImport = resolve;
		});
		const importStarted = new Promise<void>((resolve) => {
			const testState = state();
			testState.blockNextImport = importBlock;
			testState.importStarted = resolve;
		});

		// When: B loads while A's module import is still in flight.
		const loadingA = loadExtensionsCached([extensionA], cwdA);
		await importStarted;
		await loadExtensionsCached([extensionB], cwdB);
		unblockImport();
		await loadingA;
		await loadExtensionsCached([extensionA], cwdA);

		// Then: B's generation did not invalidate A's in-flight cache token.
		expect(state().moduleLoads.a).toBe(1);
		expect(state().moduleLoads.b).toBe(1);
		expect(state().factoryRuns.a).toBe(2);
		expect(state().factoryRuns.b).toBe(1);
	});
});
