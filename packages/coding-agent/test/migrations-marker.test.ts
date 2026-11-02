import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { runMigrations } from "../src/migrations.ts";

const MARKER_NAME = "migrations-state.json";
const SESSION_HEADER = `${JSON.stringify({ type: "session", cwd: "/tmp/marker-planted-cwd" })}\n`;

describe("migrations marker", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function isolatedDirs(): { agentDir: string; cwd: string } {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-marker-"));
		tempDirs.push(rootDir);
		const home = path.join(rootDir, "home");
		const cwd = path.join(rootDir, "project");
		const agentDir = path.join(home, ".senpi", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		return { agentDir, cwd };
	}

	function withAgentEnv(agentDir: string, home: string, run: () => void): void {
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		const previousHome = process.env.HOME;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.HOME = home;
		try {
			run();
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDir;
			}
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
		}
	}

	function plantScanTargets(agentDir: string, cwd: string): { jsonlPath: string; legacyProjectDir: string } {
		const jsonlPath = path.join(agentDir, "planted.jsonl");
		fs.writeFileSync(jsonlPath, SESSION_HEADER, "utf-8");
		const legacyProjectDir = path.join(cwd, ".pi");
		fs.mkdirSync(legacyProjectDir, { recursive: true });
		fs.writeFileSync(path.join(legacyProjectDir, "settings.json"), "{}\n", "utf-8");
		return { jsonlPath, legacyProjectDir };
	}

	function migratedSessionPath(agentDir: string): string {
		return path.join(agentDir, "sessions", "--tmp-marker-planted-cwd--", "planted.jsonl");
	}

	it("first run performs the scan and writes the marker", () => {
		const { agentDir, cwd } = isolatedDirs();
		const home = path.dirname(path.dirname(agentDir));
		const planted = plantScanTargets(agentDir, cwd);

		withAgentEnv(agentDir, home, () => {
			runMigrations(cwd);
		});

		expect(fs.existsSync(planted.jsonlPath)).toBe(false);
		expect(fs.existsSync(migratedSessionPath(agentDir))).toBe(true);
		expect(fs.existsSync(path.join(planted.legacyProjectDir, "settings.json"))).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".senpi", "settings.json"))).toBe(true);

		const markerPath = path.join(agentDir, MARKER_NAME);
		expect(fs.existsSync(markerPath)).toBe(true);
		const marker: unknown = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
		expect(marker).toEqual({
			schemaVersion: 1,
			completed: ["migrateLegacySenpiDirs", "migrateSessionsFromAgentRoot", "restoreDrainedPiDirs"],
		});
	});

	it("second run with the marker present does not re-scan", () => {
		const { agentDir, cwd } = isolatedDirs();
		const home = path.dirname(path.dirname(agentDir));

		withAgentEnv(agentDir, home, () => {
			runMigrations(cwd);
		});

		const planted = plantScanTargets(agentDir, cwd);

		withAgentEnv(agentDir, home, () => {
			runMigrations(cwd);
		});

		expect(fs.existsSync(planted.jsonlPath)).toBe(true);
		expect(fs.existsSync(migratedSessionPath(agentDir))).toBe(false);
		expect(fs.existsSync(planted.legacyProjectDir)).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".senpi", "settings.json"))).toBe(false);
	});

	it("malformed marker falls back to scanning", () => {
		const { agentDir, cwd } = isolatedDirs();
		const home = path.dirname(path.dirname(agentDir));
		fs.writeFileSync(
			path.join(agentDir, MARKER_NAME),
			JSON.stringify({
				schemaVersion: 999,
				completed: ["migrateLegacySenpiDirs", "migrateSessionsFromAgentRoot"],
			}),
			"utf-8",
		);
		const planted = plantScanTargets(agentDir, cwd);

		withAgentEnv(agentDir, home, () => {
			runMigrations(cwd);
		});

		expect(fs.existsSync(planted.jsonlPath)).toBe(false);
		expect(fs.existsSync(migratedSessionPath(agentDir))).toBe(true);
		expect(fs.existsSync(path.join(planted.legacyProjectDir, "settings.json"))).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".senpi", "settings.json"))).toBe(true);
	});
});
