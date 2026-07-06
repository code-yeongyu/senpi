import { afterEach, describe, expect, test } from "vitest";
import { neoBinaryRequirePath, neoPackageName, resolveNeoTarget } from "../src/cli/neo/platform.ts";
import { resolveNeoBinary } from "../src/cli/neo/resolve-binary.ts";

describe("resolveNeoBinary — resolution order", () => {
	const originalEnv = process.env.SENPI_NEO_BIN;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.SENPI_NEO_BIN;
		} else {
			process.env.SENPI_NEO_BIN = originalEnv;
		}
	});

	test("SENPI_NEO_BIN env wins over everything", () => {
		const result = resolveNeoBinary({
			envBinPath: "/tmp/env-neo",
			devBinPath: "/tmp/dev-neo",
			nodePlatform: "darwin",
			nodeArch: "arm64",
			requires: [() => "/tmp/pkg-neo"],
		});
		expect(result).toEqual({ ok: true, path: "/tmp/env-neo", source: "env" });
	});

	test("reads SENPI_NEO_BIN from process.env when not passed explicitly", () => {
		process.env.SENPI_NEO_BIN = "/tmp/from-process-env";
		const result = resolveNeoBinary({ nodePlatform: "linux", nodeArch: "x64" });
		expect(result).toEqual({ ok: true, path: "/tmp/from-process-env", source: "env" });
	});

	test("--neo-bin dev override wins over package resolution when no env", () => {
		const result = resolveNeoBinary({
			envBinPath: undefined,
			devBinPath: "/tmp/dev-neo",
			nodePlatform: "linux",
			nodeArch: "x64",
			requires: [() => "/tmp/pkg-neo"],
		});
		expect(result).toEqual({ ok: true, path: "/tmp/dev-neo", source: "dev-flag" });
	});

	test("falls back to package require.resolve when no env/dev override", () => {
		const target = resolveNeoTarget("linux", "x64");
		const expectedPath = target ? neoBinaryRequirePath(target) : "";
		let requested = "";
		const result = resolveNeoBinary({
			envBinPath: undefined,
			nodePlatform: "linux",
			nodeArch: "x64",
			requires: [
				(id) => {
					requested = id;
					return "/resolved/bin/senpi-neo";
				},
			],
		});
		expect(result).toEqual({ ok: true, path: "/resolved/bin/senpi-neo", source: "package" });
		expect(requested).toBe(expectedPath);
	});

	test("tries the second resolution root when the first throws", () => {
		const result = resolveNeoBinary({
			envBinPath: undefined,
			nodePlatform: "darwin",
			nodeArch: "arm64",
			requires: [
				() => {
					throw new Error("not found");
				},
				() => "/second/root/bin/senpi-neo",
			],
		});
		expect(result).toEqual({ ok: true, path: "/second/root/bin/senpi-neo", source: "package" });
	});

	test("all resolution roots failing → actionable error naming the package, no stack", () => {
		const result = resolveNeoBinary({
			envBinPath: undefined,
			nodePlatform: "win32",
			nodeArch: "x64",
			requires: [
				() => {
					throw new Error("MODULE_NOT_FOUND");
				},
			],
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		const target = resolveNeoTarget("win32", "x64");
		expect(result.message).toContain(target ? neoPackageName(target) : "");
		expect(result.message).toContain("npm install");
		expect(result.message).not.toContain("at ");
	});

	test("unsupported host → actionable error, no package require attempted", () => {
		let attempted = false;
		const result = resolveNeoBinary({
			envBinPath: undefined,
			nodePlatform: "freebsd",
			nodeArch: "ppc64",
			requires: [
				() => {
					attempted = true;
					return "should-not-happen";
				},
			],
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.message).toContain("no prebuilt binary");
		expect(attempted).toBe(false);
	});
});

describe("neo platform mapping table", () => {
	test.each([
		["win32", "x64", "@code-yeongyu/senpi-neo-tui-windows-x64", "bin/senpi-neo.exe"],
		["win32", "arm64", "@code-yeongyu/senpi-neo-tui-windows-arm64", "bin/senpi-neo.exe"],
		["darwin", "x64", "@code-yeongyu/senpi-neo-tui-darwin-x64", "bin/senpi-neo"],
		["darwin", "arm64", "@code-yeongyu/senpi-neo-tui-darwin-arm64", "bin/senpi-neo"],
		["linux", "x64", "@code-yeongyu/senpi-neo-tui-linux-x64", "bin/senpi-neo"],
		["linux", "arm64", "@code-yeongyu/senpi-neo-tui-linux-arm64", "bin/senpi-neo"],
	])("%s/%s → %s", (platform, arch, expectedPkg, expectedBinSuffix) => {
		const target = resolveNeoTarget(platform, arch);
		expect(target).toBeDefined();
		if (!target) throw new Error("expected target");
		expect(neoPackageName(target)).toBe(expectedPkg);
		expect(neoBinaryRequirePath(target)).toBe(`${expectedPkg}/${expectedBinSuffix}`);
	});

	test("unsupported platform/arch returns undefined", () => {
		expect(resolveNeoTarget("freebsd", "x64")).toBeUndefined();
		expect(resolveNeoTarget("linux", "ia32")).toBeUndefined();
	});
});
