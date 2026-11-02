import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { migrateLegacySenpiDirs } from "../src/legacy-senpi-dir-migration.ts";
import { runMigrations } from "../src/migrations.ts";
import { treeDigest, withFakeHome, writeUpstreamPiAgentDir } from "./support/legacy-pi-home.ts";

describe("senpi migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function upstreamPiHome(prefix: string): { fakeHome: string; cwd: string; piDir: string; newAgentDir: string } {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		tempDirs.push(rootDir);
		const fakeHome = path.join(rootDir, "home");
		const cwd = path.join(rootDir, "project");
		const piDir = path.join(fakeHome, ".pi");
		writeUpstreamPiAgentDir(path.join(piDir, "agent"));
		fs.mkdirSync(path.join(piDir, "mom"), { recursive: true });
		fs.writeFileSync(path.join(piDir, "mom", "settings.json"), "{}\n", "utf-8");
		fs.mkdirSync(path.join(cwd, ".pi", "skills"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), "{}\n", "utf-8");
		fs.writeFileSync(path.join(cwd, ".pi", "skills", "SKILL.md"), "# skill\n", "utf-8");
		return { fakeHome, cwd, piDir, newAgentDir: path.join(fakeHome, ".senpi", "agent") };
	}

	it("copies upstream pi directories into the .senpi layout and leaves the originals byte-identical", () => {
		// given
		const { fakeHome, cwd, piDir, newAgentDir } = upstreamPiHome("senpi-migration-test-");
		const piBefore = treeDigest(piDir);
		const projectBefore = treeDigest(path.join(cwd, ".pi"));

		// when
		withFakeHome(fakeHome, newAgentDir, () => runMigrations(cwd));

		// then
		expect(treeDigest(piDir)).toEqual(piBefore);
		expect(treeDigest(path.join(cwd, ".pi"))).toEqual(projectBefore);
		const copiedAgent = treeDigest(newAgentDir);
		for (const [entry, digest] of Object.entries(treeDigest(path.join(piDir, "agent")))) {
			expect(copiedAgent[entry]).toBe(digest);
		}
		expect(fs.statSync(path.join(newAgentDir, "auth.json")).mode & 0o777).toBe(0o600);
		expect(fs.existsSync(path.join(fakeHome, ".senpi", "mom", "settings.json"))).toBe(true);
		expect(fs.readFileSync(path.join(cwd, ".senpi", "skills", "SKILL.md"), "utf-8")).toBe("# skill\n");
	});

	it("copies only missing pi entries into an existing agent dir without overwriting its files", () => {
		// given
		const { fakeHome, cwd, piDir, newAgentDir } = upstreamPiHome("senpi-migration-existing-");
		fs.mkdirSync(newAgentDir, { recursive: true });
		fs.writeFileSync(path.join(newAgentDir, "settings.json"), '{"source":"senpi"}\n', "utf-8");
		const piBefore = treeDigest(piDir);

		// when
		withFakeHome(fakeHome, newAgentDir, () => runMigrations(cwd));

		// then
		expect(treeDigest(piDir)).toEqual(piBefore);
		expect(fs.readFileSync(path.join(newAgentDir, "settings.json"), "utf-8")).toBe('{"source":"senpi"}\n');
		expect(fs.readFileSync(path.join(newAgentDir, "extensions", "my-ext.ts"), "utf-8")).toBe(
			"export default () => {};\n",
		);
	});

	it("a second pass changes nothing on either side", () => {
		// given
		const { fakeHome, cwd, piDir, newAgentDir } = upstreamPiHome("senpi-migration-idempotent-");
		withFakeHome(fakeHome, newAgentDir, () => migrateLegacySenpiDirs(cwd));
		const piAfterFirst = treeDigest(piDir);
		const senpiAfterFirst = treeDigest(path.join(fakeHome, ".senpi"));
		const projectAfterFirst = treeDigest(path.join(cwd, ".senpi"));

		// when
		withFakeHome(fakeHome, newAgentDir, () => migrateLegacySenpiDirs(cwd));

		// then
		expect(treeDigest(piDir)).toEqual(piAfterFirst);
		expect(treeDigest(path.join(fakeHome, ".senpi"))).toEqual(senpiAfterFirst);
		expect(treeDigest(path.join(cwd, ".senpi"))).toEqual(projectAfterFirst);
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
		fs.writeFileSync(path.join(newAgentDir, "auth.json"), '{"chatgpt-subscription":{"type":"oauth"}}\n', "utf-8");
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
		expect(fs.readFileSync(path.join(newAgentDir, "auth.json"), "utf-8")).toBe(
			'{"chatgpt-subscription":{"type":"oauth"}}\n',
		);
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
