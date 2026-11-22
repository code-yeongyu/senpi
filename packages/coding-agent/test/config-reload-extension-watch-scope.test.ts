import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isLoadableExtensionEntry,
	isScannableExtensionDirectory,
} from "../src/core/extensions/builtin/config-reload/extension-watch-scope.ts";

const scopeRoots: string[] = [];

function extensionsRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-extension-watch-scope-"));
	scopeRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of scopeRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("config reload extension watch scope", () => {
	const dir = extensionsRoot();
	describe("#given a direct entry in the extensions directory", () => {
		it("#then treats extension sources as loadable", () => {
			expect(isLoadableExtensionEntry(dir, "diff.js")).toBe(true);
			expect(isLoadableExtensionEntry(dir, "tps.ts")).toBe(true);
			expect(isLoadableExtensionEntry(dir, "alpha.mjs")).toBe(true);
			expect(isLoadableExtensionEntry(dir, "beta.mts")).toBe(true);
		});

		it("#then ignores non-source files", () => {
			expect(isLoadableExtensionEntry(dir, "notes.md")).toBe(false);
			expect(isLoadableExtensionEntry(dir, "state.json")).toBe(false);
		});
	});

	describe("#given a subdirectory extension", () => {
		it("#then treats its discovery entry points as loadable", () => {
			expect(isLoadableExtensionEntry(dir, join("my-ext", "index.ts"))).toBe(true);
			expect(isLoadableExtensionEntry(dir, join("my-ext", "index.js"))).toBe(true);
			expect(isLoadableExtensionEntry(dir, join("my-ext", "package.json"))).toBe(true);
		});

		it("#then ignores files the loader never discovers", () => {
			expect(isLoadableExtensionEntry(dir, join("my-ext", "helper.ts"))).toBe(false);
			expect(isLoadableExtensionEntry(dir, join("my-ext", "src", "index.ts"))).toBe(false);
		});
	});

	describe("#given extension runtime state written below the discovery depth", () => {
		it("#then never treats it as a loadable entry", () => {
			const goalState = join(
				"goal",
				"no-session",
				"2fca6eb7d09fc68d11abc56e",
				"019fa192-1633-7803-9770-f2c76bd91ca3.json",
			);
			expect(isLoadableExtensionEntry(dir, goalState)).toBe(false);
			expect(isScannableExtensionDirectory(dir, join("goal", "no-session"))).toBe(false);
		});
	});

	describe("#given directory descent during a scan", () => {
		it("#then descends into the root and immediate children only", () => {
			expect(isScannableExtensionDirectory(dir, "")).toBe(true);
			expect(isScannableExtensionDirectory(dir, "goal")).toBe(true);
			expect(isScannableExtensionDirectory(dir, join("goal", "no-session"))).toBe(false);
		});
	});

	describe("#given a package manifest declaring a nested entry", () => {
		it("#then the declared entry and the directories leading to it stay watched", () => {
			const root = extensionsRoot();
			mkdirSync(join(root, "my-ext", "dist"), { recursive: true });
			writeFileSync(
				join(root, "my-ext", "package.json"),
				JSON.stringify({ name: "my-ext", pi: { extensions: ["dist/index.js"] } }),
			);

			expect(isLoadableExtensionEntry(root, join("my-ext", "dist", "index.js"))).toBe(true);
			expect(isScannableExtensionDirectory(root, join("my-ext", "dist"))).toBe(true);
			expect(isLoadableExtensionEntry(root, join("my-ext", "dist", "state.json"))).toBe(false);
		});

		it("#then a package without a manifest entry keeps runtime state unwatched", () => {
			const root = extensionsRoot();
			mkdirSync(join(root, "goal", "no-session", "hash"), { recursive: true });

			expect(isScannableExtensionDirectory(root, join("goal", "no-session"))).toBe(false);
			expect(isLoadableExtensionEntry(root, join("goal", "no-session", "hash", "id.json"))).toBe(false);
		});
	});

	describe("#given the manifest shape used by extension discovery", () => {
		it("#then resolves dot-prefixed sibling entries", () => {
			const root = extensionsRoot();
			mkdirSync(join(root, "my-package"), { recursive: true });
			writeFileSync(
				join(root, "my-package", "package.json"),
				JSON.stringify({ name: "my-package", pi: { extensions: ["./ext1.ts", "./ext2.ts"] } }),
			);

			expect(isLoadableExtensionEntry(root, join("my-package", "ext1.ts"))).toBe(true);
			expect(isLoadableExtensionEntry(root, join("my-package", "ext2.ts"))).toBe(true);
			expect(isLoadableExtensionEntry(root, join("my-package", "ext3.ts"))).toBe(false);
		});

		it("#then a manifest entry escaping its package is ignored", () => {
			const root = extensionsRoot();
			mkdirSync(join(root, "escaping"), { recursive: true });
			writeFileSync(
				join(root, "escaping", "package.json"),
				JSON.stringify({ pi: { extensions: ["../../outside.js"] } }),
			);

			expect(isLoadableExtensionEntry(root, join("escaping", "..", "..", "outside.js"))).toBe(false);
		});

		it("#then a malformed manifest degrades without throwing", () => {
			const root = extensionsRoot();
			mkdirSync(join(root, "broken"), { recursive: true });
			writeFileSync(join(root, "broken", "package.json"), "{ not json");

			expect(isLoadableExtensionEntry(root, join("broken", "dist", "index.js"))).toBe(false);
			expect(isLoadableExtensionEntry(root, join("broken", "package.json"))).toBe(true);
		});
	});
});
