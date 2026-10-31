import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as debugLog from "../src/core/hidden-stdout-log.ts";
import { FILE_STORAGE_LOCK_OPTIONS } from "../src/core/lockfile-policy.ts";
import { getSettingsPath, SettingsManager } from "../src/core/settings-manager.ts";

// A tip is recorded in state on almost every turn. While another writer (a second senpi
// process) holds the state lock, recording it must not freeze the UI, and
// the record must land once that writer is done.
describe("saving settings while another writer holds the settings lock", () => {
	let root: string;
	let agentDir: string;
	let settingsPath: string;
	let statePath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "senpi-held-lock-"));
		agentDir = join(root, "agent");
		settingsPath = join(agentDir, "settings.json");
		statePath = join(agentDir, "state.json");
		mkdirSync(dirname(settingsPath), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }), "utf-8");
		writeFileSync(statePath, "{}", "utf-8");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps the event loop running while it waits, and writes the tip once the lock frees", async () => {
		const settings = SettingsManager.create(join(root, "work"), agentDir);
		const release = await lockfile.lock(statePath, { ...FILE_STORAGE_LOCK_OPTIONS, retries: 0 });
		const waiting = new Promise<void>((resolve) => {
			const original = lockfile.lock.bind(lockfile);
			vi.spyOn(lockfile, "lock").mockImplementation((...args: Parameters<typeof lockfile.lock>) => {
				resolve();
				return original(...args);
			});
		});
		try {
			settings.setTipShown("welcome", 1_000);
			// The async lock-attempt signal is delivered while the other writer still owns the lock.
			await waiting;
			writeFileSync(statePath, JSON.stringify({ tipsHistory: { other: 500 } }));
		} finally {
			await release();
		}
		await settings.flush();
		const written = JSON.parse(readFileSync(statePath, "utf-8")) as {
			tipsHistory: Record<string, number>;
		};
		expect(written.tipsHistory).toEqual({ other: 500, welcome: 1_000 });
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "dark" });
		expect(settings.drainErrors()).toEqual([]);
	});

	it("drops a project settings write whose project stopped being trusted while it waited for the lock", async () => {
		const cwd = join(root, "work");
		const projectPath = getSettingsPath(cwd, agentDir, "project", root);
		mkdirSync(dirname(projectPath), { recursive: true });
		writeFileSync(projectPath, JSON.stringify({ packages: [] }), "utf-8");
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const release = await lockfile.lock(projectPath, { ...FILE_STORAGE_LOCK_OPTIONS, retries: 0 });

		const waiting = new Promise<void>((resolve) => {
			const original = lockfile.lock.bind(lockfile);
			vi.spyOn(lockfile, "lock").mockImplementation((...args: Parameters<typeof lockfile.lock>) => {
				resolve();
				return original(...args);
			});
		});

		settings.setProjectPackages([{ source: "npm:untrusted-write" }]);
		await waiting;
		settings.setProjectTrusted(false);
		await release();
		await settings.flush();

		expect(JSON.parse(readFileSync(projectPath, "utf-8"))).toEqual({ packages: [] });
		expect(settings.drainErrors().map((error) => error.scope)).toEqual(["project"]);
	});

	it("debug-logs a held state lock once, retains tip memory, and allows later config saves", async () => {
		const log = vi.spyOn(debugLog, "appendDebugLogEntry").mockImplementation(() => {});
		const settings = SettingsManager.create(join(root, "work"), agentDir);
		const release = await lockfile.lock(statePath, { ...FILE_STORAGE_LOCK_OPTIONS, retries: 0 });
		try {
			expect(() => settings.setTipShown("welcome", 2_000)).not.toThrow();
			await settings.flush();

			expect(settings.getTipsHistory()).toEqual({ welcome: 2_000 });
			expect(log).toHaveBeenCalledTimes(1);
			expect(settings.drainErrors()).toEqual([]);
			expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "dark" });
			settings.setTheme("light");
			await settings.flush();
			expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "light" });
			expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual({});
			expect(settings.getTipsHistory()).toEqual({ welcome: 2_000 });
			expect(settings.drainErrors()).toEqual([]);
			expect(log).toHaveBeenCalledTimes(1);
		} finally {
			await release();
		}
	}, 20_000);
});
