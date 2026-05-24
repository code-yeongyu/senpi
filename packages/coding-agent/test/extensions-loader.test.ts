import type { PathLike } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../src/core/extensions/types.ts";

describe("extension loader", () => {
	afterEach(() => {
		vi.doUnmock("node:fs");
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
		const { loadExtensions } = await import("../src/core/extensions/loader.ts");

		const result = await loadExtensions(["first.js", "second.js"], "/tmp");

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(2);
		expect(importExtension).toHaveBeenCalledTimes(2);
		expect(createJiti).toHaveBeenCalledTimes(1);
	});

	it("prefers bundled package aliases when the local coding-agent package carries dependencies", async () => {
		// given a linked local senpi install where dependencies live under
		// packages/coding-agent/node_modules instead of the workspace root
		const extensionFactory: ExtensionFactory = (pi: ExtensionAPI) => {
			pi.registerCommand("mock-command", {
				handler: async () => {},
			});
		};
		const importExtension = vi.fn(async () => extensionFactory);
		let capturedOptions: { readonly alias?: Record<string, string> } | undefined;
		const createJiti = vi.fn((_url: string, options: { readonly alias?: Record<string, string> }) => {
			capturedOptions = options;
			return {
				import: importExtension,
			};
		});
		const bundledTuiEntry = path.join(
			"packages",
			"coding-agent",
			"node_modules",
			"@earendil-works",
			"pi-tui",
			"dist",
			"index.js",
		);

		vi.doMock("jiti/static", () => ({ createJiti }));
		vi.doMock("node:fs", async () => {
			const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...fs,
				existsSync(targetPath: PathLike): boolean {
					return targetPath.toString().endsWith(bundledTuiEntry) || fs.existsSync(targetPath);
				},
			};
		});
		const { loadExtensions } = await import("../src/core/extensions/loader.ts");

		// when extension loading creates the shared jiti importer
		const result = await loadExtensions(["first.js"], "/tmp");

		// then aliased upstream TUI imports resolve to the bundled copy whose
		// transitive deps are installed beside the coding-agent package
		expect(result.errors).toHaveLength(0);
		expect(capturedOptions?.alias?.["@earendil-works/pi-tui"]).toContain(bundledTuiEntry);
	});
});
