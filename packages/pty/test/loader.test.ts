import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	getNativePtyCandidatePaths,
	getNativePtyHost,
	getNativePtySentinelExport,
	loadNativePty,
	type NativePtyBinding,
	NativePtySentinelMismatchError,
} from "../src/loader.ts";

const moduleDir = path.join(path.sep, "pkg", "dist");
const execDir = path.join(path.sep, "bundle");
const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = "2026.7.9";
const sentinelExport = "__senpiPtyV2026_7_9";

function candidate(host: string): string {
	return path.join(path.sep, "pkg", "native", "prebuilds", host, `senpi_pty.${host}.node`);
}

class MissingModuleError extends Error {
	readonly code = "MODULE_NOT_FOUND";

	constructor(modulePath: string) {
		super(`Cannot find module '${modulePath}'`);
	}
}

function missingModuleError(modulePath: string): MissingModuleError {
	return new MissingModuleError(modulePath);
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
				if (modulePath === candidate(host)) return native;
				throw missingModuleError(modulePath);
			},
			runtime: "node",
		});

		expect(result.native).toStrictEqual(native);
		expect(result.diagnostic).toBeNull();
		expect(attempted).toEqual([candidate(host)]);
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
					if (modulePath === candidate(host)) return { PtySession: class PtySession {}, version: () => "0.0.0" };
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
					if (modulePath === candidate(host)) return { PtySession: class PtySession {}, version: () => "0.0.0" };
					throw missingModuleError(modulePath);
				},
				runtime: "node",
			});
		} catch (error) {
			if (!(error instanceof NativePtySentinelMismatchError)) throw error;
			expect(error.code).toBe("native-sentinel-mismatch");
			expect(error.modulePath).toBe(candidate(host));
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
					if (modulePath === candidate(host)) {
						return { PtySession: class PtySession {}, [sentinelExport]: () => "0.0.0" };
					}
					throw missingModuleError(modulePath);
				},
				runtime: "node",
			}),
		).toThrow(NativePtySentinelMismatchError);
	});

	it("selects the shipped package prebuild candidates when the runtime is Bun", () => {
		const paths = getNativePtyCandidatePaths({
			arch: "x64",
			execDir,
			moduleDir,
			platform: "linux",
			runtime: "bun",
		});

		expect(paths).toEqual([
			path.join(path.sep, "pkg", "native", "prebuilds", "linux-x64", "senpi_pty.linux-x64.node"),
			path.join(path.sep, "pkg", "dist", "native", "prebuilds", "linux-x64", "senpi_pty.linux-x64.node"),
			path.join(path.sep, "bundle", "native", "prebuilds", "linux-x64", "senpi_pty.linux-x64.node"),
		]);
		expect(paths.every((candidatePath) => !candidatePath.includes(`${path.sep}bun${path.sep}`))).toBe(true);
	});

	it("covers the committed native/prebuilds host layout used by the package", () => {
		const host = getNativePtyHost();
		const vendoredPath = path.join(packageRoot, "native", "prebuilds", host, `senpi_pty.${host}.node`);
		const paths = getNativePtyCandidatePaths({
			execDir,
			moduleDir: path.join(packageRoot, "dist"),
			runtime: "node",
		});

		expect(paths[0]).toBe(vendoredPath);
		if (!existsSync(vendoredPath)) {
			expect(paths[0]).toContain(path.join("native", "prebuilds", host));
			return;
		}

		const result = loadNativePty({
			execDir,
			moduleDir: path.join(packageRoot, "dist"),
			runtime: "node",
		});
		expect(result.diagnostic).toBeNull();
		expect(result.native).not.toBeNull();
	});
});
