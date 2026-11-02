import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GrepEngineError, type GrepEngineRequest, type GrepEngineResult } from "../../src/core/tools/grep/engine.ts";
import { createNativeEngine, NativeGrepEngine } from "../../src/core/tools/grep/native-engine.ts";

const request: GrepEngineRequest = { pattern: "needle", paths: [resolve("src")], cwd: process.cwd() };
const result: GrepEngineResult = {
	matches: [{ path: "a.ts", line: 1, column: 3, text: "a needle", isContext: false, truncated: false }],
	fileCounts: [],
	counts: { matches: 1, files: 1, exact: false },
	filesSearched: 3,
	limitReached: true,
	perFileLimitReached: true,
	skippedOversized: 1,
	prefixSearched: 1,
	skippedBinary: 1,
	missingPaths: [resolve("missing")],
	warnings: [{ code: "TIMED_OUT", message: "partial search" }],
	timedOut: true,
	elapsedMs: 4,
	effectivePattern: "needle",
	patternKind: "regex",
	regexEngine: "rust",
};
const binding = (grep = vi.fn(async () => result)) => ({ __senpiGrepAbi1: () => "1", grep });

describe("NativeGrepEngine", () => {
	it("maps every request option and passes aligned results through unchanged", async () => {
		const native = binding();
		const engine = createNativeEngine(native);
		expect(engine).toBeInstanceOf(NativeGrepEngine);
		expect(engine.name).toBe("native");
		const options: GrepEngineRequest = {
			...request,
			paths: ["src", "test"],
			glob: ["*.ts", "!ignored/**"],
			type: "ts",
			ignoreCase: true,
			literal: false,
			multiline: true,
			hidden: false,
			gitignore: false,
			maxCount: 7,
			maxCountPerFile: 2,
			contextBefore: 3,
			contextAfter: 4,
			maxColumns: 500,
			mode: "content",
			timeoutMs: 123,
			lineStart: 2,
			lineEnd: 4,
			pcre2: false,
		};
		const controller = new AbortController();
		expect(await engine.search(options, controller.signal)).toBe(result);
		expect(native.grep).toHaveBeenCalledExactlyOnceWith(
			{ ...options, paths: options.paths.map((path) => resolve(options.cwd, path)) },
			controller.signal,
		);
		expect(options.paths).toEqual(["src", "test"]);
	});

	it("does not infer multiline defaults or rewrite patterns", async () => {
		const native = binding();
		const original = { ...request, pattern: "foo{bar}\nend" };
		await createNativeEngine(native).search(original);
		expect(native.grep).toHaveBeenCalledExactlyOnceWith(original, undefined);
	});

	it.each([
		"UNSUPPORTED_REGEX",
		"INVALID_PATTERN",
		"INVALID_GLOB",
		"UNKNOWN_TYPE",
		"PATH_NOT_FOUND",
		"ABORTED",
		"ENGINE_UNAVAILABLE",
	])("surfaces napi code %s without retrying or delegating", async (code) => {
		const error = Object.assign(new Error(`native ${code}`), { code });
		const native = binding(vi.fn().mockRejectedValue(error));
		const engine = createNativeEngine(native);
		const failure = engine.search({ ...request, pattern: "(?<=pre-)needle" });
		await expect(failure).rejects.toBeInstanceOf(GrepEngineError);
		await expect(failure).rejects.toMatchObject({ code, message: error.message, cause: error });
		expect(native.grep).toHaveBeenCalledOnce();
	});

	it("maps synchronous napi conversion errors and unknown failures with their causes", async () => {
		for (const error of [Object.assign(new Error("conversion failed"), { code: "InvalidArg" }), "binding failed"]) {
			const native = binding(
				vi.fn(() => {
					throw error;
				}),
			);
			await expect(createNativeEngine(native).search(request)).rejects.toMatchObject({
				code: "ENGINE_UNAVAILABLE",
				message: error instanceof Error ? error.message : error,
				cause: error,
			});
		}
	});

	it("rejects pcre2 with UNSUPPORTED_REGEX instead of running a ladder", async () => {
		const native = binding();
		await expect(createNativeEngine(native).search({ ...request, pcre2: true })).rejects.toMatchObject({
			code: "UNSUPPORTED_REGEX",
		});
		expect(native.grep).not.toHaveBeenCalled();
	});

	it("rejects an already aborted request before invoking napi", async () => {
		const native = binding();
		await expect(createNativeEngine(native).search(request, AbortSignal.abort())).rejects.toMatchObject({
			code: "ABORTED",
		});
		expect(native.grep).not.toHaveBeenCalled();
	});

	it("passes cancellation to an in-flight native call", async () => {
		const native = {
			__senpiGrepAbi1: () => "1",
			grep: vi.fn(
				(_options: GrepEngineRequest, signal?: AbortSignal) =>
					new Promise<GrepEngineResult>((_resolve, reject) => {
						signal?.addEventListener(
							"abort",
							() => reject(Object.assign(new Error("cancelled"), { code: "ABORTED" })),
							{ once: true },
						);
					}),
			),
		};
		const controller = new AbortController();
		const pending = createNativeEngine(native).search(request, controller.signal);
		const assertion = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
		controller.abort();
		await assertion;
		expect(native.grep).toHaveBeenCalledOnce();
	});
});
