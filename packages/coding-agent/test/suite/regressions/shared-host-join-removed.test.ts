/**
 * The interactive shared-host join is gone. An interactive launch always runs on its own local
 * runtime: neither the retired `experimental.sharedHost` setting nor the brand-prefixed
 * `ENABLE_SHARED_HOST` / `DISABLE_SHARED_HOST` env flags change that, open a socket, or print
 * anything. The retired key is removed from the GLOBAL settings file by a targeted raw rewrite (no
 * other migration lands in that write); a PROJECT file is only ignored, never rewritten. Extensions
 * no longer see a `pi.sharedHostEnabled` field.
 *
 * This file is the one place the removed names are kept, to prove they stay removed.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getDebugLogPath } from "../../../src/config.ts";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { loadExtensions } from "../../../src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { parseSettingsJson, SettingsManager, type SettingsStorage } from "../../../src/core/settings-manager.ts";
import { main } from "../../../src/main.ts";
import { stopThemeWatcher } from "../../../src/modes/interactive/theme/theme.ts";

const launchedRuntimes = vi.hoisted((): unknown[] => []);

vi.mock("../../../src/modes/interactive/interactive-mode.ts", () => ({
	InteractiveMode: class {
		constructor(runtime: unknown) {
			launchedRuntimes.push(runtime);
		}
		async init(): Promise<void> {}
		async run(): Promise<void> {}
		stop(): void {}
	},
}));

let root: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "shared-host-join-removed-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	launchedRuntimes.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const readJson = (path: string): unknown => parseSettingsJson(readFileSync(path, "utf8"));

async function launchInteractive(): Promise<{ runtime: unknown; connects: number; stderr: string }> {
	const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
	const previousCwd = process.cwd();
	const connect = vi.spyOn(Socket.prototype, "connect");
	const stderr: string[] = [];
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void stderr.push(args.join(" ")));
	vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void stderr.push(args.join(" ")));
	process.stdin.isTTY = true;
	process.stdout.isTTY = true;
	process.chdir(cwd);
	try {
		await main([]);
	} finally {
		process.chdir(previousCwd);
		process.stdin.isTTY = tty.stdin;
		process.stdout.isTTY = tty.stdout;
		stopThemeWatcher();
	}
	const runtime = launchedRuntimes.at(-1);
	if (runtime instanceof AgentSessionRuntime) await runtime.dispose();
	return { runtime, connects: connect.mock.calls.length, stderr: stderr.join("\n") };
}

const ENV_CASES: ReadonlyArray<readonly [name: string, value: string] | undefined> = [
	undefined,
	...["SENPI_ENABLE_SHARED_HOST", "OMO_ENABLE_SHARED_HOST", "SENPI_DISABLE_SHARED_HOST"].flatMap((name) =>
		["0", "1"].map((value) => [name, value] as const),
	),
];
const SETTING_CASES = [true, false, undefined] as const;
const MATRIX = SETTING_CASES.flatMap((setting) => ENV_CASES.map((env) => ({ setting, env })));

describe("interactive launch never joins a shared host", () => {
	it.each(MATRIX)("setting $setting, env $env: local runtime, no socket, no notice", async ({ setting, env }) => {
		const globalPath = join(agentDir, "settings.json");
		const settings = setting === undefined ? {} : { experimental: { sharedHost: setting } };
		writeFileSync(globalPath, JSON.stringify(settings, null, 2));
		for (const name of ["SENPI_ENABLE_SHARED_HOST", "OMO_ENABLE_SHARED_HOST", "SENPI_DISABLE_SHARED_HOST"]) {
			vi.stubEnv(name, name === env?.[0] ? env[1] : undefined);
		}

		const { runtime, connects, stderr } = await launchInteractive();

		expect(runtime).toBeInstanceOf(AgentSessionRuntime);
		expect(connects).toBe(0);
		expect(stderr).not.toContain("SHARED_HOST");
		expect(readJson(globalPath)).not.toHaveProperty("experimental");
	});
});

describe("retired pi.sharedHostEnabled extension field", () => {
	it("is not an own property of the ExtensionAPI an extension factory receives", async () => {
		let api: ExtensionAPI | undefined;

		const result = await loadExtensions(["probe.js"], cwd, undefined, undefined, {
			factoryResolver: () => (pi) => {
				api = pi;
			},
		});

		expect(result.errors).toEqual([]);
		expect(api).toBeDefined();
		expect(Object.hasOwn(api ?? {}, "sharedHostEnabled")).toBe(false);
	});
});

describe("retired experimental.sharedHost settings key", () => {
	const legacy = { queueMode: "all", retry: { maxDelayMs: 5000 } };

	it("removes the key from the global file and applies no other migration to it", () => {
		const globalPath = join(agentDir, "settings.json");
		writeFileSync(globalPath, JSON.stringify({ experimental: { sharedHost: true, other: 1 }, ...legacy }, null, 2));

		const manager = SettingsManager.create(cwd, agentDir);

		expect(readJson(globalPath)).toEqual({ experimental: { other: 1 }, ...legacy });
		expect(manager.getSteeringMode()).toBe("all");
		expect(manager.getGlobalSettings()).not.toHaveProperty("queueMode");
	});

	it("drops experimental entirely when the retired key was its only member", () => {
		const globalPath = join(agentDir, "settings.json");
		writeFileSync(globalPath, JSON.stringify({ experimental: { sharedHost: true }, theme: "dark" }));

		const manager = SettingsManager.create(cwd, agentDir);

		expect(readJson(globalPath)).toEqual({ theme: "dark" });
		expect(manager.getGlobalSettings()).not.toHaveProperty("experimental");
	});

	it("never rewrites a project file, and ignores its key in memory", () => {
		const projectPath = join(cwd, ".senpi", "settings.json");
		mkdirSync(join(cwd, ".senpi"));
		writeFileSync(projectPath, JSON.stringify({ experimental: { sharedHost: true }, theme: "light" }));
		const before = sha256(projectPath);

		const manager = SettingsManager.create(cwd, agentDir);

		expect(sha256(projectPath)).toBe(before);
		expect(manager.getProjectSettings()).toEqual({ theme: "light" });
	});

	it("leaves a global file without the key byte-identical", () => {
		const globalPath = join(agentDir, "settings.json");
		writeFileSync(globalPath, `{"queueMode":"all",   "theme":"dark"}\n`);
		const before = sha256(globalPath);

		SettingsManager.create(cwd, agentDir);

		expect(sha256(globalPath)).toBe(before);
	});

	it("rewrites a global settings.jsonc without its comments and keeps every other key", () => {
		const jsoncPath = join(agentDir, "settings.jsonc");
		writeFileSync(jsoncPath, `{\n  // my theme\n  "theme": "dark",\n  "experimental": { "sharedHost": true }\n}\n`);

		SettingsManager.create(cwd, agentDir);

		const content = readFileSync(jsoncPath, "utf8");
		expect(content).not.toContain("// my theme");
		expect(JSON.parse(content)).toEqual({ theme: "dark" });
	});

	it("loads normally when the rewrite fails and tries and logs it once per file per process", async () => {
		const global = JSON.stringify({ experimental: { sharedHost: true }, theme: "dark" });
		const path = join(agentDir, "settings.json");
		let writeAttempts = 0;
		const readOnlyStorage = (): SettingsStorage => ({
			selectSource: (scope) =>
				scope === "global" ? { path, format: "json", reason: "json-only", scope } : undefined,
			withLock(scope, fn) {
				if (fn(scope === "global" ? global : undefined) === undefined) return;
				writeAttempts += 1;
				throw new Error("EACCES: settings file is read-only");
			},
		});

		const first = SettingsManager.fromStorage(readOnlyStorage());
		const second = SettingsManager.fromStorage(readOnlyStorage());
		await first.reload();

		expect(first.getGlobalSettings()).toEqual({ theme: "dark" });
		expect(second.getGlobalSettings()).toEqual({ theme: "dark" });
		expect(writeAttempts).toBe(1);
		const log = readFileSync(getDebugLogPath(), "utf8");
		expect(log.match(/could not remove retired global settings keys/g)).toHaveLength(1);
		expect(log).toContain("EACCES: settings file is read-only");
	});
});
