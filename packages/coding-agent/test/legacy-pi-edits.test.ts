import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	findLegacyPiEdits,
	formatLegacyPiEditNotice,
	importLegacyPiConfig,
	takeLegacyPiEditNotice,
} from "../src/legacy-pi-edits.ts";
import { runMigrations } from "../src/migrations.ts";
import { treeDigest, withFakeHome, writeUpstreamPiAgentDir } from "./support/legacy-pi-home.ts";

interface CopiedHome {
	readonly fakeHome: string;
	readonly piAgentDir: string;
	readonly agentDir: string;
	readonly copiedAt: number;
}

function readState(agentDir: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(agentDir, "migrations-state.json"), "utf-8"));
}

/** Rewrites a file and pins its mtime, so ordering never depends on how fast the test runs. */
function editAt(file: string, content: string, mtimeMs: number): void {
	fs.writeFileSync(file, content);
	fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

describe("edits made in ~/.pi/agent after the copy to the agent dir (omo#9173)", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function copiedHome(): CopiedHome {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-pi-edits-"));
		tempDirs.push(rootDir);
		const fakeHome = path.join(rootDir, "home");
		const cwd = path.join(rootDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const piAgentDir = path.join(fakeHome, ".pi", "agent");
		writeUpstreamPiAgentDir(piAgentDir);
		fs.writeFileSync(path.join(piAgentDir, "models.json"), '{"providers":{}}\n');
		const agentDir = path.join(fakeHome, ".senpi", "agent");
		withFakeHome(fakeHome, agentDir, () => runMigrations(cwd));
		const copiedAt = (readState(agentDir).legacyPiAgentDir as { copiedAt: number }).copiedAt;
		return { fakeHome, piAgentDir, agentDir, copiedAt };
	}

	it("records when ~/.pi/agent was copied in the migrations state", () => {
		// given
		const before = Date.now();

		// when
		const home = copiedHome();

		// then
		expect(home.copiedAt).toBeGreaterThanOrEqual(before);
		expect(home.copiedAt).toBeLessThanOrEqual(Date.now());
		expect(readState(home.agentDir).completed).toContain("migrateLegacySenpiDirs");
	});

	it("stays quiet while ~/.pi/agent is unchanged since the copy", () => {
		// given
		const home = copiedHome();

		// when
		const notice = takeLegacyPiEditNotice({ agentDir: home.agentDir, homeDir: home.fakeHome });

		// then
		expect(notice).toEqual([]);
	});

	it("notices an edit made after the copy once, and again only after the file changes again", () => {
		// given
		const home = copiedHome();
		const piModels = path.join(home.piAgentDir, "models.json");
		editAt(piModels, '{"providers":{"mine":{}}}\n', home.copiedAt + 60_000);
		const options = { agentDir: home.agentDir, homeDir: home.fakeHome };

		// when
		const first = takeLegacyPiEditNotice(options);
		const second = takeLegacyPiEditNotice(options);
		editAt(piModels, '{"providers":{"mine":{"baseUrl":"x"}}}\n', home.copiedAt + 120_000);
		const third = takeLegacyPiEditNotice(options);

		// then
		expect(first.map((edit) => edit.file)).toEqual(["models.json"]);
		expect(first[0]?.piPath).toBe(piModels);
		expect(first[0]?.agentPath).toBe(path.join(home.agentDir, "models.json"));
		expect(second).toEqual([]);
		expect(third.map((edit) => edit.file)).toEqual(["models.json"]);
	});

	it("never writes into ~/.pi/agent while noticing", () => {
		// given
		const home = copiedHome();
		editAt(path.join(home.piAgentDir, "settings.json"), '{"theme":"light"}\n', home.copiedAt + 60_000);
		const piBefore = treeDigest(home.piAgentDir);
		const mtimeBefore = fs.statSync(path.join(home.piAgentDir, "settings.json")).mtimeMs;

		// when
		takeLegacyPiEditNotice({ agentDir: home.agentDir, homeDir: home.fakeHome });

		// then
		expect(treeDigest(home.piAgentDir)).toEqual(piBefore);
		expect(fs.statSync(path.join(home.piAgentDir, "settings.json")).mtimeMs).toBe(mtimeBefore);
	});

	it("stays quiet once the same change was carried into the agent dir", () => {
		// given
		const home = copiedHome();
		const content = '{"providers":{"mine":{}}}\n';
		editAt(path.join(home.piAgentDir, "models.json"), content, home.copiedAt + 60_000);
		editAt(path.join(home.agentDir, "models.json"), content, home.copiedAt + 90_000);

		// when
		const edits = findLegacyPiEdits({ agentDir: home.agentDir, homeDir: home.fakeHome });

		// then
		expect(edits).toEqual([]);
	});

	it("flags a newer pi file on an install migrated before the copy time was recorded", () => {
		// given
		const home = copiedHome();
		fs.writeFileSync(
			path.join(home.agentDir, "migrations-state.json"),
			`${JSON.stringify({ schemaVersion: 1, completed: ["migrateLegacySenpiDirs", "restoreDrainedPiDirs"] })}\n`,
		);
		const agentMtime = fs.statSync(path.join(home.agentDir, "models.json")).mtimeMs;
		editAt(path.join(home.piAgentDir, "models.json"), '{"providers":{"legacy":{}}}\n', agentMtime + 60_000);

		// when
		const edits = findLegacyPiEdits({ agentDir: home.agentDir, homeDir: home.fakeHome });

		// then
		expect(edits.map((edit) => edit.file)).toEqual(["models.json"]);
	});

	it("names both exact paths and the import command in the notice", () => {
		// given
		const home = copiedHome();
		editAt(path.join(home.piAgentDir, "models.json"), '{"providers":{"mine":{}}}\n', home.copiedAt + 60_000);
		const edits = findLegacyPiEdits({ agentDir: home.agentDir, homeDir: home.fakeHome });

		// when
		const notice = formatLegacyPiEditNotice(edits, home.agentDir);

		// then
		expect(notice).toContain(path.join(home.piAgentDir, "models.json"));
		expect(notice).toContain(path.join(home.agentDir, "models.json"));
		expect(notice).toContain("config import-pi models.json");
	});

	it("imports a named file after backing up the agent copy, leaving ~/.pi/agent untouched", () => {
		// given
		const home = copiedHome();
		const edited = '{"providers":{"mine":{}}}\n';
		editAt(path.join(home.piAgentDir, "models.json"), edited, home.copiedAt + 60_000);
		const agentModels = path.join(home.agentDir, "models.json");
		const agentBefore = fs.readFileSync(agentModels, "utf-8");
		const piBefore = treeDigest(home.piAgentDir);

		// when
		const result = importLegacyPiConfig(["models.json"], { agentDir: home.agentDir, homeDir: home.fakeHome });

		// then
		expect(result.failures).toEqual([]);
		expect(result.imported.map((entry) => entry.file)).toEqual(["models.json"]);
		const backup = result.imported[0]?.backupPath;
		expect(backup).toBeDefined();
		expect(fs.readFileSync(backup as string, "utf-8")).toBe(agentBefore);
		expect(fs.readFileSync(agentModels, "utf-8")).toBe(edited);
		expect(treeDigest(home.piAgentDir)).toEqual(piBefore);
		expect(findLegacyPiEdits({ agentDir: home.agentDir, homeDir: home.fakeHome })).toEqual([]);
	});

	it("imports every flagged file when none is named and refuses names outside the config allowlist", () => {
		// given
		const home = copiedHome();
		editAt(path.join(home.piAgentDir, "settings.json"), '{"theme":"light"}\n', home.copiedAt + 60_000);
		const options = { agentDir: home.agentDir, homeDir: home.fakeHome };

		// when
		const flagged = importLegacyPiConfig([], options);
		const refused = importLegacyPiConfig(["sessions", "../auth.json"], options);

		// then
		expect(flagged.imported.map((entry) => entry.file)).toEqual(["settings.json"]);
		expect(refused.imported).toEqual([]);
		expect(refused.failures.map((failure) => failure.file)).toEqual(["sessions", "../auth.json"]);
	});
});
