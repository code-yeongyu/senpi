import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getNativeGrepCandidatePaths,
	loadNativeGrep,
	NativeGrepSentinelMismatchError,
} from "../../src/core/tools/grep/native-loader.ts";
import { resolveGrepEngine } from "../../src/core/tools/grep/select-engine.ts";

const options = {
	packageDir: "/package",
	moduleDir: "/source/src/core/tools/grep",
	execPath: "/bin/senpi",
	platform: "darwin",
	arch: "arm64",
	env: {},
};
const host = "darwin-arm64";
const file = `senpi_grep.${host}.node`;
const candidates = [
	join(options.packageDir, "native/prebuilds", host, file),
	join(options.moduleDir, "../../../../native/prebuilds", host, file),
	join(dirname(options.execPath), "native/prebuilds", host, file),
];
const fakeBinding = () => ({ __senpiGrepAbi1: vi.fn(() => "1"), grep: vi.fn() });

afterEach(() => vi.restoreAllMocks());

describe("native grep loader", () => {
	it("orders package, module-relative, and executable candidates", () => {
		expect(getNativeGrepCandidatePaths(options)).toEqual(candidates);
		expect(getNativeGrepCandidatePaths({ ...options, env: { SENPI_GREP_NATIVE_PATH: "" } })).toEqual(candidates);
	});

	it("honors the relocated SENPI_PACKAGE_DIR used by compiled launchers", () => {
		const { packageDir: _, ...defaults } = options;
		expect(getNativeGrepCandidatePaths({ ...defaults, env: { SENPI_PACKAGE_DIR: "/relocated" } })[0]).toBe(
			join("/relocated/native/prebuilds", host, file),
		);
	});

	it("uses the host platform and arch in every filename", () => {
		expect(getNativeGrepCandidatePaths({ ...options, platform: "win32", arch: "x64" })).toEqual([
			join(options.packageDir, "native/prebuilds/win32-x64/senpi_grep.win32-x64.node"),
			join(options.moduleDir, "../../../../native/prebuilds/win32-x64/senpi_grep.win32-x64.node"),
			join(dirname(options.execPath), "native/prebuilds/win32-x64/senpi_grep.win32-x64.node"),
		]);
	});

	// Refs #1678: release/omob negative controls require an authoritative override.
	it("env_path_is_sole_candidate even with a loadable packaged addon", async () => {
		const binding = fakeBinding();
		const requireBinding = vi.fn((path: string) => {
			if (path === candidates[0]) return binding;
			throw new Error(`Cannot find module '${path}'`);
		});
		const loaderOptions = { ...options, requireBinding, isQuarantined: () => false };
		expect(loadNativeGrep(loaderOptions).native).toBe(binding);
		requireBinding.mockClear();
		const env = { SENPI_GREP_NATIVE_PATH: "/nonexistent" };
		await expect(
			resolveGrepEngine({ ...loaderOptions, env: { ...env, SENPI_GREP_ENGINE: "native" } }),
		).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect((await resolveGrepEngine({ ...loaderOptions, env: { ...env, SENPI_GREP_ENGINE: "auto" } })).name).toBe(
			"rg",
		);
		expect(getNativeGrepCandidatePaths({ ...options, env })).toEqual(["/nonexistent"]);
		expect(requireBinding.mock.calls).toEqual([["/nonexistent"], ["/nonexistent"]]);
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0][0]).toContain("/nonexistent");
	});

	it("does not attempt to load a binding during module import", async () => {
		vi.resetModules();
		const dlopen = vi.spyOn(process, "dlopen").mockImplementation(() => {
			throw new Error("unexpected dlopen");
		});
		await import("../../src/core/tools/grep/native-loader.ts");
		await import("../../src/core/tools/grep/native-engine.ts");
		await import("../../src/core/tools/grep/select-engine.ts");
		expect(dlopen).not.toHaveBeenCalled();
	});

	it("loads the first working candidate and validates the sentinel once", () => {
		const binding = fakeBinding();
		const requireBinding = vi.fn((path: string) => {
			if (path === candidates[0]) throw new Error("wrong architecture");
			return binding;
		});
		expect(loadNativeGrep({ ...options, requireBinding, isQuarantined: () => false })).toEqual({
			native: binding,
			diagnostic: null,
		});
		expect(requireBinding.mock.calls).toEqual([[candidates[0]], [candidates[1]]]);
		expect(binding.__senpiGrepAbi1).toHaveBeenCalledOnce();
	});

	it.each([
		{ __senpiGrepAbi1: (): string => "0", grep: vi.fn() },
		{ __senpiGrepAbi1: (): number => 1, grep: vi.fn() },
		{ grep: vi.fn() },
		{ __senpiGrepAbi1: (): string => "1" },
		null,
	])("sentinel mismatch throws without falling through: %j", (binding) => {
		const requireBinding = vi.fn(() => binding);
		expect(() => loadNativeGrep({ ...options, requireBinding, isQuarantined: () => false })).toThrow(
			NativeGrepSentinelMismatchError,
		);
		expect(requireBinding).toHaveBeenCalledExactlyOnceWith(candidates[0]);
	});

	it.each(["native", "auto"])("%s selection does not swallow a sentinel mismatch", async (engine) => {
		await expect(
			resolveGrepEngine({
				...options,
				env: { SENPI_GREP_ENGINE: engine },
				requireBinding: () => ({ ...fakeBinding(), __senpiGrepAbi1: () => "0" }),
				isQuarantined: () => false,
			}),
		).rejects.toMatchObject({ name: "NativeGrepSentinelMismatchError", modulePath: candidates[0] });
	});

	it("skips quarantined files before require, without clearing attributes", () => {
		const binding = fakeBinding();
		const events: string[] = [];
		const result = loadNativeGrep({
			...options,
			isQuarantined: (path) => {
				events.push(`probe:${path}`);
				return path === candidates[0];
			},
			requireBinding: (path) => {
				events.push(`require:${path}`);
				return binding;
			},
		});
		expect(result.native).toBe(binding);
		expect(events).toEqual([`probe:${candidates[0]}`, `probe:${candidates[1]}`, `require:${candidates[1]}`]);
	});

	it("load failure aggregates quarantine and all require causes with their paths", () => {
		const result = loadNativeGrep({
			...options,
			isQuarantined: (path) => path === candidates[0],
			requireBinding: (path) => {
				if (path === candidates[1]) throw new Error("wrong architecture");
				throw "missing addon";
			},
		});
		expect(result.native).toBeNull();
		expect(result.diagnostic).toMatchObject({
			code: "native-unavailable",
			host,
			attemptedPaths: candidates,
		});
		for (const path of candidates) expect(result.diagnostic?.cause).toContain(path);
		for (const cause of ["com.apple.quarantine", "wrong architecture", "missing addon"])
			expect(result.diagnostic?.cause).toContain(cause);
	});

	it("rg selection never probes or requires a native binding", async () => {
		const requireBinding = vi.fn();
		const isQuarantined = vi.fn();
		expect(
			(await resolveGrepEngine({ ...options, env: { SENPI_GREP_ENGINE: "rg" }, requireBinding, isQuarantined }))
				.name,
		).toBe("rg");
		expect(requireBinding).not.toHaveBeenCalled();
		expect(isQuarantined).not.toHaveBeenCalled();
	});
});
