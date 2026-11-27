import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Parser } from "web-tree-sitter";
import { selectedReadFolder } from "../../src/harness/utils/read-folders/index.ts";
import {
	loadTreeSitterFolder,
	resetTreeSitterGrammars,
} from "../../src/harness/utils/read-folders/tree-sitter/engine.ts";
import { resolveRuntimePath } from "../../src/harness/utils/read-folders/tree-sitter/grammar-assets.ts";

describe("tree-sitter runtime initialization (#4748)", () => {
	beforeEach(() => resetTreeSitterGrammars());
	afterEach(() => vi.restoreAllMocks());

	it("shares one initialization across concurrent uncached grammars", async () => {
		const init = vi.spyOn(Parser, "init");
		const folders = await Promise.all(
			(["ts", "js", "tsx", "ts", "js", "tsx"] as const).map((language) =>
				loadTreeSitterFolder(language, { fallback: selectedReadFolder, cache: false }),
			),
		);
		expect(init).toHaveBeenCalledTimes(1);
		for (const folder of folders) expect(folder).toBeDefined();
	});

	it.each([false, true])("allows another load after initialization fails with cache=%s", async (cache) => {
		const init = vi.spyOn(Parser, "init").mockRejectedValueOnce(new Error("initialization failed"));
		const options = { fallback: selectedReadFolder, cache };
		expect(await loadTreeSitterFolder("js", options)).toBeUndefined();
		expect(await loadTreeSitterFolder("js", options)).toBeDefined();
		expect(init).toHaveBeenCalledTimes(2);
	});

	it("honors an injected resolver even after the default runtime has loaded", async () => {
		const init = vi.spyOn(Parser, "init");
		expect(await loadTreeSitterFolder("js", { fallback: selectedReadFolder, cache: false })).toBeDefined();
		const wasm = await resolveRuntimePath();
		const resolveRuntime = vi.fn(async () => wasm);
		expect(
			await loadTreeSitterFolder("ts", { fallback: selectedReadFolder, cache: false, resolveRuntime }),
		).toBeDefined();
		expect(resolveRuntime).toHaveBeenCalledTimes(1);
		expect(init).toHaveBeenCalledTimes(1);
	});

	it("does not reuse the default runtime for a different injected path", async () => {
		const init = vi.spyOn(Parser, "init");
		expect(await loadTreeSitterFolder("js", { fallback: selectedReadFolder, cache: false })).toBeDefined();
		init.mockRejectedValueOnce(new Error("invalid runtime"));
		expect(
			await loadTreeSitterFolder("js", {
				fallback: selectedReadFolder,
				cache: false,
				resolveRuntime: async () => "/missing/runtime.wasm",
			}),
		).toBeUndefined();
		expect(init).toHaveBeenCalledTimes(2);
		expect(init.mock.calls[1][0]?.locateFile?.("web-tree-sitter.wasm", "")).toBe("/missing/runtime.wasm");
	});

	it("allows another load after runtime resolution rejects", async () => {
		const resolveRuntime = vi.fn(resolveRuntimePath).mockRejectedValueOnce(new Error("resolution failed"));
		const options = { fallback: selectedReadFolder, resolveRuntime };
		expect(await loadTreeSitterFolder("js", options)).toBeUndefined();
		expect(await loadTreeSitterFolder("js", options)).toBeDefined();
		expect(resolveRuntime).toHaveBeenCalledTimes(2);
	});
});
