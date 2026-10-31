import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Language, Parser } from "web-tree-sitter";
import { selectedReadFolder } from "../../src/harness/utils/read-folders/index.ts";
import {
	loadTreeSitterFolder,
	resetTreeSitterGrammars,
} from "../../src/harness/utils/read-folders/tree-sitter/engine.ts";
import { resolveRuntimePath } from "../../src/harness/utils/read-folders/tree-sitter/grammar-assets.ts";

const fallback = selectedReadFolder;

describe("tree-sitter runtime coordination (#4752)", () => {
	beforeEach(() => resetTreeSitterGrammars());
	afterEach(() => vi.restoreAllMocks());

	it.each([
		{ name: "same path concurrent", differentPath: false, fail: false },
		{ name: "different paths concurrent", differentPath: true, fail: false },
		{ name: "failure then retry", differentPath: false, fail: true },
	])("$name", async ({ differentPath, fail }) => {
		const wasm = await resolveRuntimePath();
		if (!wasm) throw new Error("runtime unavailable");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const resolved = Promise.withResolvers<void>();
		const init = vi.spyOn(Parser, "init");
		if (fail) {
			init.mockImplementationOnce(async () => {
				entered.resolve();
				await release.promise;
				throw new Error("initialization failed");
			});
		} else {
			const load = Language.load.bind(Language);
			vi.spyOn(Language, "load").mockImplementationOnce(async (path) => {
				entered.resolve();
				await release.promise;
				return load(path);
			});
		}
		const first = loadTreeSitterFolder("ts", { fallback, cache: false, resolveRuntime: async () => wasm });
		await entered.promise;
		const second = loadTreeSitterFolder("js", {
			fallback,
			cache: false,
			resolveRuntime: async () => {
				queueMicrotask(resolved.resolve);
				return differentPath ? `${dirname(wasm)}/./web-tree-sitter.wasm` : wasm;
			},
		});
		await resolved.promise;
		// Drain the engine's lazy import, not a clock interval, while the first operation is held.
		await vi.dynamicImportSettled();
		const callsWhileHeld = init.mock.calls.length;
		release.resolve();
		const folders = await Promise.all([first, second]);
		expect(callsWhileHeld).toBe(1);
		if (fail) {
			expect(folders).toEqual([undefined, undefined]);
			expect(
				await loadTreeSitterFolder("js", { fallback, cache: false, resolveRuntime: async () => wasm }),
			).toBeDefined();
		} else {
			for (const folder of folders) expect(folder).toBeDefined();
		}
		expect(init).toHaveBeenCalledTimes(differentPath || fail ? 2 : 1);
	});

	it("keeps a newer runtime entry when a pre-reset initialization fails", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const resolved = Promise.withResolvers<void>();
		const init = vi.spyOn(Parser, "init").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			throw new Error("old initialization failed");
		});
		const wasm = await resolveRuntimePath();
		const options = { fallback, cache: false, resolveRuntime: async () => wasm };
		const old = loadTreeSitterFolder("ts", options);
		await entered.promise;
		resetTreeSitterGrammars();
		const newer = loadTreeSitterFolder("js", {
			...options,
			resolveRuntime: async () => {
				queueMicrotask(resolved.resolve);
				return wasm;
			},
		});
		await resolved.promise;
		release.resolve();
		expect(await old).toBeUndefined();
		expect(await newer).toBeDefined();
		expect(await loadTreeSitterFolder("tsx", options)).toBeDefined();
		expect(init).toHaveBeenCalledTimes(2);
	});

	it("keeps a newer grammar entry when a pre-reset language load fails", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const load = vi.spyOn(Language, "load").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			throw new Error("old language load failed");
		});
		const options = { fallback };
		const old = loadTreeSitterFolder("js", options);
		await entered.promise;
		resetTreeSitterGrammars();
		const newer = loadTreeSitterFolder("js", options);
		release.resolve();
		expect(await old).toBeUndefined();
		expect(await newer).toBeDefined();
		expect(await loadTreeSitterFolder("js", options)).toBeDefined();
		expect(load).toHaveBeenCalledTimes(2);
	});

	it.each([true, false])("retains a missing grammar only with cache=%s", async (cache) => {
		const resolveGrammar = vi.fn(async () => undefined);
		const init = vi.spyOn(Parser, "init");
		const options = { fallback, cache, resolveGrammar };
		expect(await loadTreeSitterFolder("js", options)).toBeUndefined();
		expect(await loadTreeSitterFolder("js", options)).toBeUndefined();
		expect(resolveGrammar).toHaveBeenCalledTimes(cache ? 1 : 2);
		expect(init).not.toHaveBeenCalled();
	});
});
