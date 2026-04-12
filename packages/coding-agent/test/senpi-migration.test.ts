import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { runMigrations } from "../src/migrations.js";

describe("senpi migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("moves legacy .pi directories into the .senpi layout when the new paths do not exist", () => {
		// given
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-migration-test-"));
		tempDirs.push(rootDir);
		const fakeHome = path.join(rootDir, "home");
		const cwd = path.join(rootDir, "project");
		const oldAgentDir = path.join(fakeHome, ".pi", "agent");
		const oldMomDir = path.join(fakeHome, ".pi", "mom");
		const oldProjectDir = path.join(cwd, ".pi");
		fs.mkdirSync(oldAgentDir, { recursive: true });
		fs.mkdirSync(oldMomDir, { recursive: true });
		fs.mkdirSync(oldProjectDir, { recursive: true });
		fs.writeFileSync(path.join(oldAgentDir, "settings.json"), "{}\n", "utf-8");
		fs.writeFileSync(path.join(oldMomDir, "auth.json"), "{}\n", "utf-8");
		fs.writeFileSync(path.join(oldProjectDir, "settings.json"), "{}\n", "utf-8");

		const newAgentDir = path.join(fakeHome, ".senpi", "agent");
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		const previousHome = process.env.HOME;
		process.env[ENV_AGENT_DIR] = newAgentDir;
		process.env.HOME = fakeHome;

		try {
			// when
			runMigrations(cwd);
		} finally {
			// then
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

		expect(fs.existsSync(path.join(fakeHome, ".pi", "agent"))).toBe(false);
		expect(fs.existsSync(path.join(fakeHome, ".pi", "mom"))).toBe(false);
		expect(fs.existsSync(path.join(cwd, ".pi"))).toBe(false);
		expect(fs.existsSync(path.join(fakeHome, ".senpi", "agent", "settings.json"))).toBe(true);
		expect(fs.existsSync(path.join(fakeHome, ".senpi", "mom", "auth.json"))).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".senpi", "settings.json"))).toBe(true);
	});
});
