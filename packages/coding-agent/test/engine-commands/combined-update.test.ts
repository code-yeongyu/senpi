import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_NAME, getAgentDir, PACKAGE_NAME, VERSION } from "../../src/config.ts";
import { DefaultPackageManager } from "../../src/core/package-manager.ts";
import { handlePackageCommand } from "../../src/package-manager-cli.ts";

let root: string;
let originalCwd: string;
let originalExitCode: typeof process.exitCode;

function lines(spy: { mock: { calls: unknown[][] } }): string[] {
	return spy.mock.calls.map(([message]) => stripVTControlCharacters(String(message)));
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "combined-update-")));
	mkdirSync(join(root, "project"), { recursive: true });
	vi.stubEnv("HOME", root);
	originalCwd = process.cwd();
	originalExitCode = process.exitCode;
	process.exitCode = undefined;
	process.chdir(join(root, "project"));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ packageName: PACKAGE_NAME, version: VERSION })),
	);
});

afterEach(() => {
	process.chdir(originalCwd);
	process.exitCode = originalExitCode;
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(join(getAgentDir(), "settings.json"), { force: true });
	rmSync(root, { recursive: true, force: true });
});

describe("update --all: the package part, then the engine itself (review M4)", () => {
	// Pinned from the base commit 36344cdb9d: with no reachable release lookup the engine half fails after the
	// package half, so the package update, its line, the lookup failure and exit code 1 come in that order.
	it("updates every installed package once, then checks the engine", async () => {
		const update = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue(undefined);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await handlePackageCommand(["update", "--all"])).toBe(true);

		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith(undefined);
		expect(lines(log)).toEqual(["Updated packages"]);
		expect(lines(error)).toEqual([`Error: Could not determine latest ${APP_NAME} version.`]);
		expect(process.exitCode).toBe(1);
	});

	it("stops before the engine update when the package update fails", async () => {
		vi.spyOn(DefaultPackageManager.prototype, "update").mockRejectedValue(new Error("registry down"));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await handlePackageCommand(["update", "--all"])).toBe(true);

		expect(lines(error)).toEqual(["Error: registry down"]);
		expect(lines(log)).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});
});
