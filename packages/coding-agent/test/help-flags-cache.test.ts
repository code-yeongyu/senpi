import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type HelpFlagsScope, readHelpFlagsCache, writeHelpFlagsCache } from "../src/cli/help-flags-cache.ts";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import type { ExtensionFlag } from "../src/core/extensions/types.ts";

/**
 * The cache-invalidation contract behind `--help` (oh-my-openagent#8371), exercised in process on
 * the runtime Vitest runs on (Node). `test/suite/regressions/help-fast-path.test.ts` proves the same
 * sequence end to end through a CLI child that runs under Bun; this file keeps the Node side covered
 * (senpi#4554).
 *
 * Each change also moves the touched path's mtime explicitly, so the stamp differs even on a file
 * system whose timestamp granularity would otherwise fold the write into the cached tick.
 */

let hostDir: string;
let agentDir: string;
let projectDir: string;
let extensionsDir: string;
let extensionPath: string;
let scope: HelpFlagsScope;
let nextMtimeSeconds: number;

function flag(name: string, path: string): ExtensionFlag {
	return { name, type: "boolean", default: false, description: "help cache probe flag", extensionPath: path };
}

function touchForward(path: string): void {
	nextMtimeSeconds += 10;
	utimesSync(path, nextMtimeSeconds, nextMtimeSeconds);
}

function cacheAlpha(): ExtensionFlag[] {
	const flags = [flag("help-probe-alpha", extensionPath)];
	writeHelpFlagsCache({ scope, flags, extensionPaths: [extensionPath] });
	return flags;
}

beforeEach(() => {
	hostDir = mkdtempSync(join(tmpdir(), "senpi-help-flags-cache-"));
	agentDir = join(hostDir, "agent");
	projectDir = join(hostDir, "project");
	extensionsDir = join(agentDir, "extensions");
	extensionPath = join(extensionsDir, "help-probe.js");
	mkdirSync(extensionsDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(extensionPath, "export default function alpha() {}\n");
	nextMtimeSeconds = Math.floor(Date.now() / 1000);
	scope = { cwd: projectDir, agentDir, cliExtensionPaths: [], noExtensions: false, projectTrusted: true };
});

afterEach(() => {
	rmSync(hostDir, { recursive: true, force: true });
});

describe("help flags cache (oh-my-openagent#8371, senpi#4554)", () => {
	test("#given unchanged discovery inputs #when the cache is read #then the cached flags are returned", () => {
		const flags = cacheAlpha();

		expect(readHelpFlagsCache(scope)).toEqual(flags);
	});

	test("#given the cached extension file changed #when the cache is read #then it is rejected", () => {
		cacheAlpha();
		writeFileSync(extensionPath, "export default function beta() { return 1; }\n");
		touchForward(extensionPath);

		expect(readHelpFlagsCache(scope)).toBeUndefined();
	});

	test("#given a new extension file appeared #when the cache is read #then it is rejected", () => {
		cacheAlpha();
		writeFileSync(join(extensionsDir, "help-probe-2.js"), "export default function gamma() {}\n");
		touchForward(extensionsDir);

		expect(readHelpFlagsCache(scope)).toBeUndefined();
	});

	test("#given global settings appeared after caching #when the cache is read #then it is rejected", () => {
		cacheAlpha();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));

		expect(readHelpFlagsCache(scope)).toBeUndefined();
	});

	test("#given cached global settings changed #when the cache is read #then it is rejected", () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
		cacheAlpha();
		writeFileSync(settingsPath, JSON.stringify({ theme: "light" }));
		touchForward(settingsPath);

		expect(readHelpFlagsCache(scope)).toBeUndefined();
	});

	test("#given project settings appeared after caching #when the cache is read #then it is rejected", () => {
		cacheAlpha();
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(join(projectDir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ theme: "dark" }));

		expect(readHelpFlagsCache(scope)).toBeUndefined();
	});
});
