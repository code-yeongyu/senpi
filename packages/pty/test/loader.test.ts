import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	getNativePtyCandidatePaths,
	getNativePtySentinelExport,
	loadNativePty,
	type NativePtyBinding,
	type NativePtyRuntime,
	NativePtySentinelMismatchError,
} from "../src/loader.ts";

const moduleDir = path.join(path.sep, "pkg", "dist");
const execDir = path.join(path.sep, "bundle");
const packageVersion = "2026.7.5-2";
const sentinelExport = "__senpiPtyV2026_7_5";

function candidate(runtime: NativePtyRuntime, host: string): string {
	return path.join(path.sep, "pkg", "native", runtime, "prebuilds", host, `senpi_pty.${host}.node`);
}

function missingModuleError(modulePath: string): Error & { code?: string } {
	const error = new Error(`Cannot find module '${modulePath}'`) as Error & { code?: string };
	error.code = "MODULE_NOT_FOUND";
	return error;
}

describe("loadNativePty", () => {
	it("loads the first host prebuild whose sentinel export is valid", () => {
		const host = "darwin-arm64";
		const native: NativePtyBinding = {
			PtySession: class PtySession {},
			[sentinelExport]: () => packageVersion,
		};
		const attempted: string[] = [];

		const result = loadNativePty({
			arch: "arm64",
			execDir,
			moduleDir,
			platform: "darwin",
			requireBinding(modulePath) {
				attempted.push(modulePath);
				if (modulePath === candidate("node", host)) return native;
				throw missingModuleError(modulePath);
			},
			runtime: "node",
		});

		expect(result.native).toBe(native);
		expect(result.diagnostic).toBeNull();
		expect(attempted).toEqual([candidate("node", host)]);
	});

	it("derives the sentinel export from the package version", () => {
		expect(getNativePtySentinelExport(packageVersion)).toBe(sentinelExport);
	});

	it("returns a native-unavailable diagnostic when every candidate is missing", () => {
		const attempted: string[] = [];
		const result = loadNativePty({
			arch: "x64",
			execDir,
			moduleDir,
			platform: "linux",
			requireBinding(modulePath) {
				attempted.push(modulePath);
				throw missingModuleError(modulePath);
			},
			runtime: "node",
		});

		const expectedPaths = getNativePtyCandidatePaths({
			arch: "x64",
			execDir,
			moduleDir,
			platform: "linux",
			runtime: "node",
		});
		expect(result.native).toBeNull();
		const diagnostic = result.diagnostic;
		if (diagnostic === null) throw new Error("expected native-unavailable diagnostic");
		expect(diagnostic.code).toBe("native-unavailable");
		expect(diagnostic.host).toBe("linux-x64");
		expect(diagnostic.runtime).toBe("node");
		expect(diagnostic.attemptedPath).toBe(expectedPaths[0]);
		expect(diagnostic.attemptedPaths).toEqual(expectedPaths);
		expect(attempted).toEqual(expectedPaths);
	});

	it("throws a typed sentinel mismatch error when a candidate loads without the versioned sentinel", () => {
		const host = "darwin-arm64";

		expect(() =>
			loadNativePty({
				arch: "arm64",
				execDir,
				moduleDir,
				platform: "darwin",
				requireBinding(modulePath) {
					if (modulePath === candidate("node", host))
						return { PtySession: class PtySession {}, version: () => "0.0.0" };
					throw missingModuleError(modulePath);
				},
				runtime: "node",
			}),
		).toThrow(NativePtySentinelMismatchError);

		try {
			loadNativePty({
				arch: "arm64",
				execDir,
				moduleDir,
				platform: "darwin",
				requireBinding(modulePath) {
					if (modulePath === candidate("node", host))
						return { PtySession: class PtySession {}, version: () => "0.0.0" };
					throw missingModuleError(modulePath);
				},
				runtime: "node",
			});
		} catch (error) {
			if (!(error instanceof NativePtySentinelMismatchError)) throw error;
			expect(error.code).toBe("native-sentinel-mismatch");
			expect(error.modulePath).toBe(candidate("node", host));
			expect(error.expectedExport).toBe(sentinelExport);
			expect(error.actualExports).toEqual(["PtySession", "version"]);
		}
	});

	it("throws a typed sentinel mismatch error when the versioned sentinel returns the wrong package version", () => {
		const host = "darwin-arm64";

		expect(() =>
			loadNativePty({
				arch: "arm64",
				execDir,
				moduleDir,
				platform: "darwin",
				requireBinding(modulePath) {
					if (modulePath === candidate("node", host)) {
						return { PtySession: class PtySession {}, [sentinelExport]: () => "0.0.0" };
					}
					throw missingModuleError(modulePath);
				},
				runtime: "node",
			}),
		).toThrow(NativePtySentinelMismatchError);
	});

	it("selects Bun prebuild candidates when the runtime is Bun", () => {
		const paths = getNativePtyCandidatePaths({
			arch: "x64",
			execDir,
			moduleDir,
			platform: "linux",
			runtime: "bun",
		});

		expect(paths).toEqual([
			path.join(path.sep, "pkg", "native", "bun", "prebuilds", "linux-x64", "senpi_pty.linux-x64.node"),
			path.join(path.sep, "pkg", "dist", "native", "bun", "prebuilds", "linux-x64", "senpi_pty.linux-x64.node"),
			path.join(path.sep, "bundle", "native", "bun", "prebuilds", "linux-x64", "senpi_pty.linux-x64.node"),
		]);
	});
});
