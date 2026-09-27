import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrations.ts";
import { treeDigest, withFakeHome, writeUpstreamPiAgentDir } from "./support/legacy-pi-home.ts";

const MOVE_ERA_STATE = `${JSON.stringify({
	schemaVersion: 1,
	completed: ["migrateLegacySenpiDirs", "migrateSessionsFromAgentRoot"],
})}\n`;

interface DrainedHome {
	readonly fakeHome: string;
	readonly cwd: string;
	readonly piDir: string;
	readonly agentDir: string;
}

describe("restoring a pi agent directory an earlier start moved away", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function drainedHome(options: { readonly keepEmptyAgentDir: boolean; readonly state?: string }): DrainedHome {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dir-restore-"));
		tempDirs.push(rootDir);
		const fakeHome = path.join(rootDir, "home");
		const cwd = path.join(rootDir, "project");
		const piDir = path.join(fakeHome, ".pi");
		const agentDir = path.join(fakeHome, ".senpi", "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(options.keepEmptyAgentDir ? path.join(piDir, "agent") : piDir, { recursive: true });
		writeUpstreamPiAgentDir(agentDir);
		fs.mkdirSync(path.join(agentDir, "app-server"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "app-server", "state.json"), "{}\n");
		fs.writeFileSync(path.join(agentDir, "credential-pool-state.json"), "{}\n");
		fs.mkdirSync(path.join(agentDir, "logs"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "logs", "debug.log"), "log\n");
		if (options.state !== undefined) {
			fs.writeFileSync(path.join(agentDir, "migrations-state.json"), options.state);
		}
		return { fakeHome, cwd, piDir, agentDir };
	}

	function pickUpstreamEntries(digest: Readonly<Record<string, string>>): Record<string, string> {
		const upstream = ["settings.json", "auth.json", "sessions/", "extensions/"];
		return Object.fromEntries(
			Object.entries(digest).filter(([entry]) => upstream.some((root) => entry === root || entry.startsWith(root))),
		);
	}

	it("copies the upstream pi entries back into an emptied ~/.pi/agent and leaves the agent dir alone", () => {
		// given
		const home = drainedHome({ keepEmptyAgentDir: true, state: MOVE_ERA_STATE });
		const agentBefore = treeDigest(home.agentDir);

		// when
		withFakeHome(home.fakeHome, home.agentDir, () => runMigrations(home.cwd));

		// then
		const restored = treeDigest(path.join(home.piDir, "agent"));
		expect(restored).toEqual(pickUpstreamEntries(agentBefore));
		expect(fs.statSync(path.join(home.piDir, "agent", "auth.json")).mode & 0o777).toBe(0o600);
		const { "migrations-state.json": _state, ...agentAfter } = treeDigest(home.agentDir);
		const { "migrations-state.json": _stateBefore, ...agentBeforeWithoutState } = agentBefore;
		expect(agentAfter).toEqual(agentBeforeWithoutState);
	});

	it("recreates a ~/.pi/agent that was renamed away by a start that predates the migrations state file", () => {
		// given
		const home = drainedHome({ keepEmptyAgentDir: false });

		// when
		withFakeHome(home.fakeHome, home.agentDir, () => runMigrations(home.cwd));

		// then
		expect(fs.readFileSync(path.join(home.piDir, "agent", "settings.json"), "utf-8")).toBe('{"theme":"pi-dark"}\n');
		expect(fs.existsSync(path.join(home.piDir, "agent", "sessions", "--work-project--", "2026-09-01_pi.jsonl"))).toBe(
			true,
		);
	});

	it("restores ~/.pi/mom from the brand mom dir the earlier start moved it to", () => {
		// given
		const home = drainedHome({ keepEmptyAgentDir: true, state: MOVE_ERA_STATE });
		fs.mkdirSync(path.join(home.fakeHome, ".senpi", "mom"), { recursive: true });
		fs.writeFileSync(path.join(home.fakeHome, ".senpi", "mom", "settings.json"), '{"mom":true}\n');

		// when
		withFakeHome(home.fakeHome, home.agentDir, () => runMigrations(home.cwd));

		// then
		expect(fs.readFileSync(path.join(home.piDir, "mom", "settings.json"), "utf-8")).toBe('{"mom":true}\n');
		expect(fs.existsSync(path.join(home.fakeHome, ".senpi", "mom", "settings.json"))).toBe(true);
	});

	it("replaces the empty auth and model-store stubs pi wrote into the emptied dir with the moved files", () => {
		// given
		const home = drainedHome({ keepEmptyAgentDir: true, state: MOVE_ERA_STATE });
		for (const stub of ["auth.json", "models-store.json"]) {
			fs.writeFileSync(path.join(home.piDir, "agent", stub), "{}", { mode: 0o600 });
		}

		// when
		withFakeHome(home.fakeHome, home.agentDir, () => runMigrations(home.cwd));

		// then
		expect(fs.readFileSync(path.join(home.piDir, "agent", "auth.json"), "utf-8")).toBe(
			fs.readFileSync(path.join(home.agentDir, "auth.json"), "utf-8"),
		);
		expect(fs.statSync(path.join(home.piDir, "agent", "auth.json")).mode & 0o777).toBe(0o600);
		expect(fs.readFileSync(path.join(home.piDir, "agent", "models-store.json"), "utf-8")).toBe("{}");
		expect(fs.existsSync(path.join(home.piDir, "agent", "extensions", "my-ext.ts"))).toBe(true);
	});

	it("restores when HOME is reached through a symlink and the agent dir resolves to its real path", () => {
		// given
		const home = drainedHome({ keepEmptyAgentDir: true, state: MOVE_ERA_STATE });
		const linkedHome = path.join(path.dirname(home.fakeHome), "linked-home");
		fs.symlinkSync(home.fakeHome, linkedHome, "dir");

		// when
		withFakeHome(linkedHome, fs.realpathSync(home.agentDir), () => runMigrations(home.cwd));

		// then
		expect(fs.readFileSync(path.join(home.piDir, "agent", "settings.json"), "utf-8")).toBe('{"theme":"pi-dark"}\n');
	});

	it("leaves a ~/.pi/agent that still holds files untouched", () => {
		// given
		const home = drainedHome({ keepEmptyAgentDir: true, state: MOVE_ERA_STATE });
		fs.writeFileSync(path.join(home.piDir, "agent", "settings.json"), '{"theme":"user-since"}\n');
		const piBefore = treeDigest(home.piDir);

		// when
		withFakeHome(home.fakeHome, home.agentDir, () => runMigrations(home.cwd));

		// then
		expect(treeDigest(home.piDir)).toEqual(piBefore);
	});

	it("does not create a pi directory for a machine that never had one", () => {
		// given
		const home = drainedHome({ keepEmptyAgentDir: false, state: MOVE_ERA_STATE });
		fs.rmSync(home.piDir, { recursive: true });

		// when
		withFakeHome(home.fakeHome, home.agentDir, () => runMigrations(home.cwd));

		// then
		expect(fs.existsSync(home.piDir)).toBe(false);
	});

	it("does not restore without evidence that a moving start ran on this agent dir", () => {
		// given
		const home = drainedHome({
			keepEmptyAgentDir: true,
			state: `${JSON.stringify({ schemaVersion: 1, completed: ["migrateSessionsFromAgentRoot"] })}\n`,
		});

		// when
		withFakeHome(home.fakeHome, home.agentDir, () => runMigrations(home.cwd));

		// then
		expect(fs.readdirSync(path.join(home.piDir, "agent"))).toEqual([]);
	});

	it("does not write into ~/.pi when the agent dir is an external sandbox", () => {
		// given
		const home = drainedHome({ keepEmptyAgentDir: true, state: MOVE_ERA_STATE });
		const sandboxAgentDir = path.join(path.dirname(home.fakeHome), "sandbox", "agent");
		fs.cpSync(home.agentDir, sandboxAgentDir, { recursive: true });

		// when
		withFakeHome(home.fakeHome, sandboxAgentDir, () => runMigrations(home.cwd));

		// then
		expect(fs.readdirSync(path.join(home.piDir, "agent"))).toEqual([]);
	});

	it("restores once: a later start keeps what the user changed in ~/.pi/agent since", () => {
		// given
		const home = drainedHome({ keepEmptyAgentDir: true, state: MOVE_ERA_STATE });
		withFakeHome(home.fakeHome, home.agentDir, () => runMigrations(home.cwd));
		fs.rmSync(path.join(home.piDir, "agent", "extensions"), { recursive: true });
		fs.writeFileSync(path.join(home.piDir, "agent", "settings.json"), '{"theme":"user-since"}\n');
		const piAfterUserEdits = treeDigest(home.piDir);
		const agentAfterFirst = treeDigest(home.agentDir);

		// when
		withFakeHome(home.fakeHome, home.agentDir, () => runMigrations(home.cwd));

		// then
		expect(treeDigest(home.piDir)).toEqual(piAfterUserEdits);
		expect(treeDigest(home.agentDir)).toEqual(agentAfterFirst);
	});
});
