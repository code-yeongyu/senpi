import { describe, expect, it } from "vitest";
import { bunVersionSatisfies, isInstalledPackageScript } from "../src/bun-runtime.ts";

describe("bunVersionSatisfies", () => {
	it("accepts the 1.4.0 floor and anything newer", () => {
		expect(bunVersionSatisfies("1.4.0")).toBe(true);
		expect(bunVersionSatisfies("1.4.2\n")).toBe(true);
		expect(bunVersionSatisfies("1.10.0")).toBe(true);
		expect(bunVersionSatisfies("2.0.0")).toBe(true);
		expect(bunVersionSatisfies("1.5.0-canary.3+abc")).toBe(true);
	});

	it("rejects older, empty, and unparseable versions", () => {
		expect(bunVersionSatisfies("1.3.13")).toBe(false);
		expect(bunVersionSatisfies("0.9.9")).toBe(false);
		expect(bunVersionSatisfies("")).toBe(false);
		expect(bunVersionSatisfies(undefined)).toBe(false);
		expect(bunVersionSatisfies("bun")).toBe(false);
	});
});

describe("isInstalledPackageScript", () => {
	it("recognizes npm, pnpm, npx, and project-local installs", () => {
		expect(isInstalledPackageScript("/usr/local/lib/node_modules/@code-yeongyu/senpi/dist/cli.js")).toBe(true);
		expect(
			isInstalledPackageScript(
				"/home/u/.local/share/pnpm/global/5/.pnpm/@code-yeongyu+senpi@1/node_modules/@code-yeongyu/senpi/dist/cli.js",
			),
		).toBe(true);
		expect(isInstalledPackageScript("/home/u/.npm/_npx/abc/node_modules/@code-yeongyu/senpi/dist/cli.js")).toBe(true);
		expect(isInstalledPackageScript("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\x\\cli.js")).toBe(true);
	});

	it("treats a source checkout as not installed", () => {
		expect(isInstalledPackageScript("/work/senpi/packages/coding-agent/dist/cli.js")).toBe(false);
		expect(isInstalledPackageScript("/work/senpi/packages/coding-agent/src/cli.ts")).toBe(false);
	});
});
