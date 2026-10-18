import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

const projectDirs: string[] = [];
const agentDir = getAgentDir();
const settingsPath = join(agentDir, "settings.json");
const statePath = join(agentDir, "state.json");

function createProjectDir(): string {
	const projectDir = mkdtempSync(join(tmpdir(), "senpi-settings-tips-"));
	projectDirs.push(projectDir);
	return projectDir;
}

function writeSettings(settings: unknown): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings)}\n`, "utf-8");
}

afterEach(() => {
	rmSync(settingsPath, { force: true });
	rmSync(statePath, { force: true });
	for (const projectDir of projectDirs.splice(0)) {
		rmSync(projectDir, { recursive: true, force: true });
	}
});

describe("SettingsManager tips settings", () => {
	it("enables tips by default and respects an explicit false", () => {
		expect(SettingsManager.inMemory().getTipsEnabled()).toBe(true);
		expect(SettingsManager.inMemory({ tips: false }).getTipsEnabled()).toBe(false);
	});

	it("round-trips and persists tips history in the quarantined agent directory", async () => {
		const manager = SettingsManager.create(createProjectDir());
		const history = {
			"welcome-tip": 1_700_000_000_000,
			"shortcut-tip": 1_700_000_100_000,
		};

		manager.setTipsHistory(history);
		expect(manager.getTipsHistory()).toEqual(history);
		await manager.flush();

		const persisted = JSON.parse(readFileSync(statePath, "utf-8")) as { tipsHistory?: unknown };
		expect(persisted.tipsHistory).toEqual(history);
	});

	it("merges concurrent tip records from separate managers without clobbering", async () => {
		// Two sessions each record a different tip from the same starting snapshot.
		// Per-id nested merging must preserve BOTH entries; a whole-field write would
		// let the last writer erase the other session's tip.
		writeSettings({ tipsHistory: { "existing-tip": 1_700_000_000_000 } });

		const sessionA = SettingsManager.create(createProjectDir());
		const sessionB = SettingsManager.create(createProjectDir());

		sessionA.setTipShown("tip-from-a", 1_700_000_200_000);
		sessionB.setTipShown("tip-from-b", 1_700_000_300_000);
		await sessionA.flush();
		await sessionB.flush();

		const persisted = JSON.parse(readFileSync(statePath, "utf-8")) as {
			tipsHistory?: Record<string, number>;
		};
		expect(persisted.tipsHistory?.["tip-from-a"]).toBe(1_700_000_200_000);
		expect(persisted.tipsHistory?.["tip-from-b"]).toBe(1_700_000_300_000);
		expect(persisted.tipsHistory?.["existing-tip"]).toBe(1_700_000_000_000);
	});

	it("falls back to an empty history for malformed persisted values", () => {
		const projectDir = createProjectDir();
		const malformedValues: readonly unknown[] = ["not-a-history", [], null];

		for (const tipsHistory of malformedValues) {
			rmSync(statePath, { force: true });
			writeSettings({ tipsHistory });
			expect(SettingsManager.create(projectDir).getTipsHistory()).toEqual({});
		}
	});
});
