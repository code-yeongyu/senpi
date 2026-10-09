import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_STORAGE_LOCK_OPTIONS } from "../src/core/lockfile-policy.ts";
import { getSettingsPath, SettingsManager } from "../src/core/settings-manager.ts";

// A tip is recorded in settings on almost every turn. While another writer (a second senpi
// process, a settings editor) holds the settings lock, recording it must not freeze the UI, and
// the record must land once that writer is done.
describe("saving settings while another writer holds the settings lock", () => {
	let root: string;
	let agentDir: string;
	let settingsPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "senpi-held-lock-"));
		agentDir = join(root, "agent");
		settingsPath = join(agentDir, "settings.json");
		mkdirSync(dirname(settingsPath), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }), "utf-8");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps the event loop running while it waits, and writes the tip once the lock frees", async () => {
		const settings = SettingsManager.create(join(root, "work"), agentDir);
		const release = await lockfile.lock(settingsPath, { ...FILE_STORAGE_LOCK_OPTIONS, retries: 0 });
		let ticks = 0;
		const ticker = setInterval(() => ticks++, 5);

		// The other writer finishes after a short while; a frozen event loop would never get here.
		const otherWriterDone = new Promise<void>((resolve) =>
			setTimeout(() => {
				void release().then(resolve);
			}, 300),
		);
		settings.setTipShown("welcome", 1_000);
		await otherWriterDone;
		await settings.flush();
		clearInterval(ticker);

		expect(ticks).toBeGreaterThan(10);
		const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			theme: string;
			tipsHistory: Record<string, number>;
		};
		expect(written.tipsHistory).toEqual({ welcome: 1_000 });
		expect(written.theme).toBe("dark");
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

	it("reports a lock that never frees without throwing at the caller, and keeps the setting in memory", async () => {
		const settings = SettingsManager.create(join(root, "work"), agentDir);
		const release = await lockfile.lock(settingsPath, { ...FILE_STORAGE_LOCK_OPTIONS, retries: 0 });
		try {
			expect(() => settings.setTipShown("welcome", 2_000)).not.toThrow();
			await settings.flush();

			expect(settings.getTipsHistory()).toEqual({ welcome: 2_000 });
			const errors = settings.drainErrors();
			expect(errors).toHaveLength(1);
			expect(errors[0]?.scope).toBe("global");
			expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "dark" });
		} finally {
			await release();
		}
	}, 20_000);
});
