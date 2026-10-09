import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cachedExtensionFactory,
	clearExtensionCache,
	type ExtensionModuleImporter,
	extensionModuleGenerationCount,
	extensionModuleImporter,
	rememberExtensionFactory,
} from "../../src/core/extensions/extension-module-cache.ts";

const roots: string[] = [];

function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-extension-module-cache-"));
	roots.push(root);
	return root;
}

function writeSource(path: string, body: string): string {
	writeFileSync(path, body, "utf-8");
	return path;
}

/** A rewrite inside the same filesystem timestamp tick must still read as changed. */
function touchForward(path: string): void {
	const future = new Date(Date.now() + 2_000);
	utimesSync(path, future, future);
}

function fakeImporter(files: string[], options: { reportsFiles?: boolean } = {}) {
	const state = { imports: 0, disposed: 0 };
	const importer: ExtensionModuleImporter = {
		async import() {
			state.imports++;
			return () => undefined;
		},
		dispose() {
			state.disposed++;
		},
	};
	if (options.reportsFiles !== false) {
		importer.compiledFiles = () => files;
	}
	return { importer, state };
}

beforeEach(() => {
	clearExtensionCache();
});

afterEach(() => {
	clearExtensionCache();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("extension module cache", () => {
	it("keeps one generation while the compiled sources are unchanged", async () => {
		// Given: a generation compiled from two source files.
		const root = fixtureRoot();
		const entry = writeSource(join(root, "extension.ts"), "export default () => {};\n");
		const dependency = writeSource(join(root, "dependency.ts"), "export const value = 1;\n");
		const { importer } = fakeImporter([entry, dependency]);
		const before = extensionModuleGenerationCount();
		const factory = () => undefined;
		await extensionModuleImporter(async () => importer);
		rememberExtensionFactory(entry, factory, importer);

		// When: the same source is requested again.
		const reused = cachedExtensionFactory(entry);
		await extensionModuleImporter(async () => {
			throw new Error("must not compile a second generation");
		});

		// Then
		expect(reused).toBe(factory);
		expect(extensionModuleGenerationCount() - before).toBe(1);
	});

	it("drops the generation when the entry source changes", async () => {
		// Given
		const root = fixtureRoot();
		const entry = writeSource(join(root, "extension.ts"), "export default () => {};\n");
		const { importer, state } = fakeImporter([entry]);
		await extensionModuleImporter(async () => importer);
		rememberExtensionFactory(entry, () => undefined, importer);

		// When
		writeSource(entry, "export default () => 1;\n");
		touchForward(entry);

		// Then: the stale generation is no longer served, and its graph is left runnable for the
		// sessions still holding factories from it.
		expect(cachedExtensionFactory(entry)).toBeUndefined();
		expect(state.disposed).toBe(0);
	});

	it("drops the generation when a compiled dependency changes", async () => {
		// Given
		const root = fixtureRoot();
		const entry = writeSource(join(root, "extension.ts"), "export default () => {};\n");
		const dependency = writeSource(join(root, "dependency.ts"), "export const value = 1;\n");
		const { importer } = fakeImporter([entry, dependency]);
		await extensionModuleImporter(async () => importer);
		rememberExtensionFactory(entry, () => undefined, importer);

		// When: only the dependency is edited.
		writeSource(dependency, "export const value = 2;\n");
		touchForward(dependency);

		// Then
		expect(cachedExtensionFactory(entry)).toBeUndefined();
	});

	it("drops the generation when a compiled source disappears", async () => {
		// Given
		const root = fixtureRoot();
		const entry = writeSource(join(root, "extension.ts"), "export default () => {};\n");
		const dependency = writeSource(join(root, "dependency.ts"), "export const value = 1;\n");
		const { importer } = fakeImporter([entry, dependency]);
		await extensionModuleImporter(async () => importer);
		rememberExtensionFactory(entry, () => undefined, importer);

		// When
		rmSync(dependency);

		// Then
		expect(cachedExtensionFactory(entry)).toBeUndefined();
	});

	it("ignores a factory compiled by a generation that was already dropped", async () => {
		// Given: a load in flight under one importer while a source change drops that generation.
		const root = fixtureRoot();
		const entry = writeSource(join(root, "extension.ts"), "export default () => {};\n");
		const inFlight = fakeImporter([entry]);
		await extensionModuleImporter(async () => inFlight.importer);
		rememberExtensionFactory(entry, () => undefined, inFlight.importer);
		writeSource(entry, "export default () => 1;\n");
		touchForward(entry);
		expect(cachedExtensionFactory(entry)).toBeUndefined();
		const successor = fakeImporter([entry]);
		await extensionModuleImporter(async () => successor.importer);

		// When: the in-flight load files its result after the swap.
		const staleFactory = () => undefined;
		rememberExtensionFactory(entry, staleFactory, inFlight.importer);

		// Then: the successor generation never serves bytes it did not compile.
		expect(cachedExtensionFactory(entry)).toBeUndefined();
	});

	it("never caches an importer that cannot report its compiled sources", async () => {
		// Given: the jiti path, whose graph cannot be checked for staleness.
		const root = fixtureRoot();
		const entry = writeSource(join(root, "extension.ts"), "export default () => {};\n");
		const { importer } = fakeImporter([entry], { reportsFiles: false });
		await extensionModuleImporter(async () => importer);

		// When
		rememberExtensionFactory(entry, () => undefined, importer);

		// Then
		expect(cachedExtensionFactory(entry)).toBeUndefined();
	});
});
