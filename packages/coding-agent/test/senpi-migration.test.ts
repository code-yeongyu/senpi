import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { OFFICIAL_PI_MIGRATION_MARKER } from "../src/legacy-senpi-dir-migration.ts";
import { runMigrations } from "../src/migrations.ts";

describe("senpi migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function withFakeEnv(fakeHome: string, agentDir: string, run: () => void): void {
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		const previousHome = process.env.HOME;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.HOME = fakeHome;
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

	it("copies official .pi directories into the .senpi layout and leaves the originals in place", () => {
		// given
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-migration-test-"));
		tempDirs.push(rootDir);
		const fakeHome = path.join(rootDir, "home");
		const cwd = path.join(rootDir, "project");
		const oldAgentDir = path.join(fakeHome, ".pi", "agent");
		const oldMomDir = path.join(fakeHome, ".pi", "mom");
		const oldProjectDir = path.join(cwd, ".pi");
		fs.mkdirSync(path.join(oldAgentDir, "extensions", "custom"), { recursive: true });
		fs.mkdirSync(oldMomDir, { recursive: true });
		fs.mkdirSync(oldProjectDir, { recursive: true });
		fs.writeFileSync(path.join(oldAgentDir, "settings.json"), "{}\n", "utf-8");
		fs.writeFileSync(path.join(oldAgentDir, "extensions", "custom", "index.ts"), "export {}\n", "utf-8");
		fs.writeFileSync(path.join(oldMomDir, "auth.json"), "{}\n", "utf-8");
		fs.writeFileSync(path.join(oldProjectDir, "settings.json"), "{}\n", "utf-8");

		const newAgentDir = path.join(fakeHome, ".senpi", "agent");

		// when
		withFakeEnv(fakeHome, newAgentDir, () => runMigrations(cwd));

		// then
		expect(fs.existsSync(path.join(oldAgentDir, "settings.json"))).toBe(true);
		expect(fs.existsSync(path.join(oldAgentDir, "extensions", "custom", "index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(oldMomDir, "auth.json"))).toBe(true);
		expect(fs.existsSync(path.join(oldProjectDir, "settings.json"))).toBe(true);
		expect(fs.existsSync(path.join(newAgentDir, "settings.json"))).toBe(true);
		expect(fs.existsSync(path.join(newAgentDir, "extensions", "custom", "index.ts"))).toBe(true);
		expect(fs.existsSync(path.join(fakeHome, ".senpi", "mom", "auth.json"))).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".senpi", "settings.json"))).toBe(true);
		expect(fs.readFileSync(path.join(newAgentDir, OFFICIAL_PI_MIGRATION_MARKER), "utf-8")).toBe(`${oldAgentDir}\n`);
		expect(fs.existsSync(path.join(fakeHome, ".senpi", "mom", OFFICIAL_PI_MIGRATION_MARKER))).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".senpi", OFFICIAL_PI_MIGRATION_MARKER))).toBe(true);
	});

	it("does not copy official .pi directories again once the marker exists", () => {
		// given
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-migration-rerun-test-"));
		tempDirs.push(rootDir);
		const fakeHome = path.join(rootDir, "home");
		const cwd = path.join(rootDir, "project");
		const oldAgentDir = path.join(fakeHome, ".pi", "agent");
		const newAgentDir = path.join(fakeHome, ".senpi", "agent");
		fs.mkdirSync(oldAgentDir, { recursive: true });
		fs.mkdirSync(newAgentDir, { recursive: true });
		fs.writeFileSync(path.join(oldAgentDir, "settings.json"), '{"source":"pi"}\n', "utf-8");
		fs.writeFileSync(path.join(newAgentDir, "settings.json"), '{"source":"current"}\n', "utf-8");
		withFakeEnv(fakeHome, newAgentDir, () => runMigrations(cwd));
		fs.writeFileSync(path.join(oldAgentDir, "models.json"), '{"providers":{}}\n', "utf-8");

		// when
		withFakeEnv(fakeHome, newAgentDir, () => runMigrations(cwd));

		// then
		expect(fs.readFileSync(path.join(newAgentDir, "settings.json"), "utf-8")).toBe('{"source":"current"}\n');
		expect(fs.existsSync(path.join(newAgentDir, "models.json"))).toBe(false);
		expect(fs.existsSync(path.join(oldAgentDir, "models.json"))).toBe(true);
		expect(fs.existsSync(path.join(oldAgentDir, "settings.json"))).toBe(true);
	});

	it("moves missing nested legacy agent files without overwriting current files", () => {
		// given
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-nested-migration-test-"));
		tempDirs.push(rootDir);
		const fakeHome = path.join(rootDir, "home");
		const cwd = path.join(rootDir, "project");
		const newAgentDir = path.join(fakeHome, ".senpi", "agent");
		const nestedOldAgentDir = path.join(fakeHome, ".senpi", ".pi", "agent");
		fs.mkdirSync(newAgentDir, { recursive: true });
		fs.mkdirSync(nestedOldAgentDir, { recursive: true });
		fs.writeFileSync(path.join(newAgentDir, "settings.json"), '{"source":"current"}\n', "utf-8");
		fs.writeFileSync(path.join(newAgentDir, "auth.json"), '{"openai-codex":{"type":"oauth"}}\n', "utf-8");
		fs.writeFileSync(path.join(nestedOldAgentDir, "settings.json"), '{"source":"legacy"}\n', "utf-8");
		fs.writeFileSync(
			path.join(nestedOldAgentDir, "auth.json"),
			'{"anthropic":{"type":"api_key","key":"legacy"}}\n',
			"utf-8",
		);
		fs.writeFileSync(path.join(nestedOldAgentDir, "models.json"), '{"providers":{}}\n', "utf-8");

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

		expect(fs.readFileSync(path.join(newAgentDir, "settings.json"), "utf-8")).toBe('{"source":"current"}\n');
		expect(fs.readFileSync(path.join(newAgentDir, "auth.json"), "utf-8")).toBe('{"openai-codex":{"type":"oauth"}}\n');
		expect(fs.readFileSync(path.join(newAgentDir, "models.json"), "utf-8")).toBe('{"providers":{}}\n');
		expect(fs.existsSync(path.join(nestedOldAgentDir, "models.json"))).toBe(false);
		expect(fs.existsSync(path.join(nestedOldAgentDir, "settings.json"))).toBe(true);
		expect(fs.existsSync(path.join(nestedOldAgentDir, "auth.json"))).toBe(true);
	});

	it("does not drain home config through .pi symlink when agent dir is an external sandbox", () => {
		// given
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-symlink-migration-test-"));
		tempDirs.push(rootDir);
		const fakeHome = path.join(rootDir, "home");
		const cwd = path.join(rootDir, "project");
		const sandboxAgentDir = path.join(rootDir, "sandbox", "agent");
		const currentAgentDir = path.join(fakeHome, ".senpi", "agent");
		fs.mkdirSync(currentAgentDir, { recursive: true });
		fs.mkdirSync(sandboxAgentDir, { recursive: true });
		fs.symlinkSync(".senpi", path.join(fakeHome, ".pi"), "dir");
		fs.writeFileSync(path.join(currentAgentDir, "models.json"), '{"providers":{}}\n', "utf-8");

		const previousAgentDir = process.env[ENV_AGENT_DIR];
		const previousHome = process.env.HOME;
		process.env[ENV_AGENT_DIR] = sandboxAgentDir;
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

		expect(fs.readFileSync(path.join(currentAgentDir, "models.json"), "utf-8")).toBe('{"providers":{}}\n');
		expect(fs.existsSync(path.join(sandboxAgentDir, "models.json"))).toBe(false);
	});
});
