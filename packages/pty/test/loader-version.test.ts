import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getNativePtySentinelExport, NATIVE_PTY_ABI_VERSION, NATIVE_PTY_PACKAGE_VERSION } from "../src/loader.ts";

// The compiled Bun single-file binary made `import.meta.url` resolve to `/$bunfs/root/pi`,
// so the eager `require("../package.json")` threw at module load and crashed every CLI
// command. These tests pin the resolved-version contract that fix depends on: they cannot
// even be collected unless `../src/loader.ts` loaded without throwing, and they assert the
// sentinel export is derived from that resolved version so a regression surfaces here.

const SENTINEL_SHAPE = /^__senpiPtyAbi\d+$/;
const SEMVER_CORE = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

// Independent node/tsx resolution path: read the package's own package.json the way a
// consumer running under node would, so we cross-check against the module-load result
// rather than trusting the value the module produced.
function readOwnPackageVersion(): string {
	const raw: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
	if (!isRecord(raw) || typeof raw.version !== "string") {
		throw new Error("test fixture: package.json is missing a string version");
	}
	return raw.version;
}

// The sentinel is decoupled from the package version: it encodes only the native ABI
// version, so a CalVer bump must NOT change it (that coupling is exactly what crashed
// the prior release's publish).

describe("NATIVE_PTY_PACKAGE_VERSION", () => {
	it("resolves to the package.json version at module load (proving load did not throw)", () => {
		expect(typeof NATIVE_PTY_PACKAGE_VERSION).toBe("string");
		expect(NATIVE_PTY_PACKAGE_VERSION.length).toBeGreaterThan(0);
		expect(NATIVE_PTY_PACKAGE_VERSION).toMatch(SEMVER_CORE);
		expect(NATIVE_PTY_PACKAGE_VERSION).toBe(readOwnPackageVersion());
	});
});

describe("getNativePtySentinelExport", () => {
	it("derives the sentinel from the ABI version, not the package version", () => {
		const sentinel = getNativePtySentinelExport();
		expect(sentinel).toMatch(SENTINEL_SHAPE);
		expect(sentinel).toBe(`__senpiPtyAbi${NATIVE_PTY_ABI_VERSION}`);
	});

	it("stays stable across package versions (CalVer bump must not change it)", () => {
		const fromPackageVersion = getNativePtySentinelExport(NATIVE_PTY_ABI_VERSION);
		expect(fromPackageVersion).toBe(getNativePtySentinelExport());
		// The sentinel must not embed the CalVer package version.
		expect(getNativePtySentinelExport()).not.toContain(NATIVE_PTY_PACKAGE_VERSION.replace(/[.+-]/g, "_"));
	});

	it.each([
		["1", "__senpiPtyAbi1"],
		["2", "__senpiPtyAbi2"],
	])("maps ABI version %s to sentinel %s", (abi, expected) => {
		expect(getNativePtySentinelExport(abi)).toBe(expected);
	});
});
