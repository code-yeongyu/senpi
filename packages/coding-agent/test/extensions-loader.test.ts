import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../src/core/extensions/types.js";

describe("extension loader", () => {
	afterEach(() => {
		vi.doUnmock("jiti/static");
		vi.resetModules();
	});

	it("reuses one jiti importer when loading an extension batch", async () => {
		const extensionFactory: ExtensionFactory = (pi: ExtensionAPI) => {
			pi.registerCommand("mock-command", {
				handler: async () => {},
			});
		};
		const importExtension = vi.fn(async () => extensionFactory);
		const createJiti = vi.fn(() => ({
			import: importExtension,
		}));

		vi.doMock("jiti/static", () => ({ createJiti }));
		const { loadExtensions } = await import("../src/core/extensions/loader.js");

		const result = await loadExtensions(["first.js", "second.js"], "/tmp");

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(2);
		expect(importExtension).toHaveBeenCalledTimes(2);
		expect(createJiti).toHaveBeenCalledTimes(1);
	});
});
