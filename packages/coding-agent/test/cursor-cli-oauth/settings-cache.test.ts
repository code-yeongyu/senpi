import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCursorCliOauthProviderSettingsFromDisk } from "../../src/core/extensions/builtin/cursor-cli-oauth/settings.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "senpi-cursor-oauth-cache-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
	else process.env.SENPI_CODING_AGENT_DIR = originalAgentDir;
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Cursor CLI OAuth provider settings cache", () => {
	let cwd: string;
	let agentDir: string;
	let settingsPath: string;
	let createSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		agentDir = temporaryDirectory();
		cwd = temporaryDirectory();
		process.env.SENPI_CODING_AGENT_DIR = agentDir;
		mkdirSync(agentDir, { recursive: true });
		settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ cursorCliOauthProvider: { enabled: true, pinnedAccount: "first" } }),
		);
		createSpy = vi.spyOn(SettingsManager, "create");
	});

	afterEach(() => {
		createSpy.mockRestore();
	});

	it("#given an unchanged settings file #when the loader is called repeatedly #then SettingsManager.create runs once, not per call", () => {
		const N = 5;
		for (let i = 0; i < N; i++) loadCursorCliOauthProviderSettingsFromDisk(cwd);

		expect(createSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
		// The loader caches by (cwd, mtime, size); unchanged files must not create
		// a fresh SettingsManager + locked disk reads on every call. Current code
		// has no cache => N creates.
		expect(createSpy.mock.calls.length).toBeLessThan(N);
	});

	it("#given a rewritten settings file #when the loader runs again #then the cache invalidates and create runs", () => {
		loadCursorCliOauthProviderSettingsFromDisk(cwd);
		const before = createSpy.mock.calls.length;

		writeFileSync(
			settingsPath,
			JSON.stringify({ cursorCliOauthProvider: { enabled: false, pinnedAccount: "second" } }),
		);
		const result = loadCursorCliOauthProviderSettingsFromDisk(cwd);

		expect(createSpy.mock.calls.length).toBeGreaterThan(before);
		expect(result.pinnedAccount).toBe("second");
	});
});
