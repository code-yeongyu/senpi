import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.doUnmock("jiti/static");
	vi.doUnmock("../../src/core/extensions/bun-extension-importer.ts");
	vi.resetModules();
});

describe("extension importer ownership", () => {
	it("leaves the Bun transformer unloaded when the runtime uses Node", async () => {
		// Given: observe module evaluation, not just factory construction.
		const importBun = vi.fn(() => ({ createBunExtensionImporter: vi.fn() }));
		vi.doMock("../../src/core/extensions/bun-extension-importer.ts", importBun);
		vi.doMock("jiti/static", () => ({ createJiti: () => ({ import: async () => () => {} }) }));
		const { loadExtensions } = await import("../../src/core/extensions/loader.ts");
		// When
		const result = await loadExtensions(["extension.ts"], process.cwd());
		// Then
		expect(result.errors).toEqual([]);
		expect(importBun).not.toHaveBeenCalled();
	});
	it("does not construct an unused importer when every factory is cached", async () => {
		// Given: real cache and factory execution, observing only the transformer boundary.
		const factory = vi.fn(() => {});
		const createJiti = vi.fn(() => ({ import: async () => factory }));
		vi.doMock("jiti/static", () => ({ createJiti }));
		const { loadExtensionsCached } = await import("../../src/core/extensions/loader.ts");
		const first = await loadExtensionsCached(["extension.ts"], process.cwd());
		expect(first.errors).toEqual([]);
		createJiti.mockClear();
		factory.mockClear();
		// When
		const second = await loadExtensionsCached(["extension.ts"], process.cwd());
		// Then
		expect(second.errors).toEqual([]);
		expect(factory).toHaveBeenCalledOnce();
		expect(createJiti).not.toHaveBeenCalled();
	});
});
