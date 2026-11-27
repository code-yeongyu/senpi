import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Args } from "../../../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createSessionManager } from "../../../src/main.ts";
import { getDefaultSessionDir, getDefaultSessionDirPath, SessionManager } from "../../../src/core/session-manager.ts";
import { holdSessionFile, liveSessionHolders } from "../../../src/core/session-holders.ts";
import { dropStartClaim } from "../../../src/core/session-start-claim.ts";
import { allScopeSessions, currentScopeSessions } from "../../../src/modes/interactive/resume-rebind.ts";

// omo-desktop-app#8097: the desktop keeps its sessions in its own store and registers that store in the
// agent dir's shared session index; a running terminal's session list shows them as they are created.

let tempDir: string;
let agentDir: string;
let project: string;
let appStore: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "senpi-8097-"));
	agentDir = join(tempDir, "agent");
	project = join(tempDir, "project");
	appStore = join(tempDir, "desktop-state", "omo-sessions");
	mkdirSync(project, { recursive: true });
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

function writeSession(dir: string, id: string, cwd: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${id}.jsonl`);
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-17T00:00:00.000Z", cwd })}\n`,
	);
	return file;
}

function registerStore(name: string, contents: string): void {
	const dir = join(agentDir, "session-stores");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), contents);
}

const terminal = () => ({
	getCwd: () => project,
	getHomeSessionDir: () => getDefaultSessionDirPath(project),
	usesDefaultSessionDir: () => true,
});

const ids = (sessions: readonly { readonly id: string }[]) => sessions.map((session) => session.id).sort();

describe("desktop#8097: a terminal lists the sessions the desktop keeps in its own store", () => {
	it("lists this folder's app sessions in the current scope and every app session in the all scope", async () => {
		writeSession(getDefaultSessionDir(project), "cli-own", project);
		const appThread = writeSession(join(appStore, "omo-instance"), "app-thread", project);
		writeSession(join(appStore, "omo-instance"), "app-elsewhere", join(tempDir, "other"));
		registerStore("omo-desktop-a.json", JSON.stringify({ version: 1, root: appStore }));

		const current = await currentScopeSessions(terminal());
		const all = await allScopeSessions(terminal());

		expect(ids(current)).toEqual(["app-thread", "cli-own"]);
		expect(current.find((session) => session.id === "app-thread")?.path).toBe(appThread);
		expect(ids(all)).toEqual(["app-elsewhere", "app-thread", "cli-own"]);
	});

	it("shows a session the app creates after the first listing in the next listing of the same process", async () => {
		registerStore("omo-desktop-a.json", JSON.stringify({ version: 1, root: appStore }));
		writeSession(join(appStore, "omo-instance"), "app-first", project);
		expect(ids(await currentScopeSessions(terminal()))).toEqual(["app-first"]);

		writeSession(join(appStore, "omo-instance"), "app-created-later", project);

		expect(ids(await currentScopeSessions(terminal()))).toEqual(["app-created-later", "app-first"]);
		expect(ids(await SessionManager.listAll())).toEqual(["app-created-later", "app-first"]);
	});

	it("ignores malformed, relative and missing registrations without hiding the valid store", async () => {
		writeSession(join(appStore, "omo-instance"), "app-thread", project);
		registerStore("broken.json", "{ not json");
		registerStore("relative.json", JSON.stringify({ version: 1, root: "relative/store" }));
		registerStore("gone.json", JSON.stringify({ version: 1, root: join(tempDir, "removed-store") }));
		registerStore("omo-desktop-a.json", JSON.stringify({ version: 1, root: appStore }));

		expect(ids(await currentScopeSessions(terminal()))).toEqual(["app-thread"]);
	});

	it("keeps an explicit custom session dir to that dir alone", async () => {
		const custom = join(tempDir, "custom-sessions");
		writeSession(custom, "custom-own", project);
		writeSession(join(appStore, "omo-instance"), "app-thread", project);
		registerStore("omo-desktop-a.json", JSON.stringify({ version: 1, root: appStore }));

		expect(ids(await SessionManager.list(project, custom))).toEqual(["custom-own"]);
		expect(ids(await SessionManager.listAll(custom))).toEqual(["custom-own"]);
	});

	it("keeps the terminal's own session folder after resuming an app session, for listing and /new", async () => {
		const own = writeSession(getDefaultSessionDir(project), "cli-own", project);
		const appThread = writeSession(join(appStore, "omo-instance"), "app-thread", project);
		registerStore("omo-desktop-a.json", JSON.stringify({ version: 1, root: appStore }));

		// What /resume's switchSession does with the picked path.
		const resumed = SessionManager.open(appThread, undefined, undefined);
		await resumed.adoptHomeSessionDir();

		expect(resumed.getSessionDir()).toBe(dirname(appThread));
		expect(resumed.usesDefaultSessionDir()).toBe(true);
		expect(resumed.getHomeSessionDir()).toBe(getDefaultSessionDirPath(project));
		expect(ids(await currentScopeSessions(resumed))).toEqual(["app-thread", "cli-own"]);

		// What /new does next: create in the current manager's session home.
		const created = SessionManager.create(project, resumed.getHomeSessionDir());
		created.newSession();
		expect(dirname(created.getSessionFile() ?? "")).toBe(dirname(own));

		const inPlace = resumed.newSession();
		expect(dirname(inPlace ?? "")).toBe(dirname(own));
		expect(readdirSync(join(appStore, "omo-instance")).sort()).toEqual(["app-thread.jsonl"]);
	});

	it("keeps the terminal's own session folder when `--session <id>` opens an app session", async () => {
		const own = writeSession(getDefaultSessionDir(project), "cli-own", project);
		writeSession(join(appStore, "omo-instance"), "app-thread", project);
		registerStore("omo-desktop-a.json", JSON.stringify({ version: 1, root: appStore }));
		const args: Args = {
			messages: [],
			fileArgs: [],
			unknownFlags: new Map(),
			diagnostics: [],
			session: "app-thread",
		};

		const opened = await createSessionManager(args, project, undefined, SettingsManager.inMemory(), "print");

		expect(opened.getSessionId()).toBe("app-thread");
		expect(opened.getHomeSessionDir()).toBe(getDefaultSessionDirPath(project));
		expect(ids(await currentScopeSessions(opened))).toEqual(["app-thread", "cli-own"]);
		expect(dirname(opened.newSession() ?? "")).toBe(dirname(own));
		// No session file lands in the desktop's store. While this start loads, its start claim (senpi#5988) sits beside
		// the session it guards, and neither listing reads it as a session.
		const appFile = join(appStore, "omo-instance", "app-thread.jsonl");
		const inStore = readdirSync(join(appStore, "omo-instance"));
		expect(inStore.filter((name) => name !== "session-holders")).toEqual(["app-thread.jsonl"]);
		expect(await liveSessionHolders(appFile, "app-thread")).toEqual([expect.objectContaining({ pid: process.pid })]);
		expect(ids(await currentScopeSessions(opened))).toEqual(["app-thread", "cli-own"]);
		expect(ids(await allScopeSessions(opened))).toEqual(expect.arrayContaining(["app-thread", "cli-own"]));

		// Once the start holds the session and lets it go, nothing of the lock is left in the store.
		const hold = await holdSessionFile(appFile, "app-thread", { cwd: project, expectExisting: true });
		hold.release();
		expect(readdirSync(join(appStore, "omo-instance"))).toEqual(["app-thread.jsonl"]);
	});

	it("leaves nothing in the desktop's store when a `--session <id>` start of an app session does not open it", async () => {
		writeSession(join(appStore, "omo-instance"), "app-thread", project);
		registerStore("omo-desktop-a.json", JSON.stringify({ version: 1, root: appStore }));
		const args: Args = {
			messages: [],
			fileArgs: [],
			unknownFlags: new Map(),
			diagnostics: [],
			session: "app-thread",
		};
		await createSessionManager(args, project, undefined, SettingsManager.inMemory(), "print");

		await dropStartClaim("app-thread");

		expect(readdirSync(join(appStore, "omo-instance"))).toEqual(["app-thread.jsonl"]);
	});

	it("ignores a registration whose version is not 1", async () => {
		writeSession(join(appStore, "omo-instance"), "app-thread", project);
		const otherStore = join(tempDir, "future-state", "omo-sessions");
		writeSession(join(otherStore, "omo-instance"), "future-thread", project);
		registerStore("omo-desktop-a.json", JSON.stringify({ version: 1, root: appStore }));
		registerStore("future.json", JSON.stringify({ version: 2, root: otherStore }));
		registerStore("unversioned.json", JSON.stringify({ root: otherStore }));

		expect(ids(await currentScopeSessions(terminal()))).toEqual(["app-thread"]);
		expect(ids(await allScopeSessions(terminal()))).toEqual(["app-thread"]);
	});

	it("writes no summary cache into the app's store and keeps it under the agent dir", async () => {
		writeSession(join(appStore, "omo-instance"), "app-thread", project);
		registerStore("omo-desktop-a.json", JSON.stringify({ version: 1, root: appStore }));

		await currentScopeSessions(terminal());
		await allScopeSessions(terminal());

		expect(readdirSync(join(appStore, "omo-instance"))).toEqual(["app-thread.jsonl"]);
		expect(existsSync(join(agentDir, "cache", "session-store-summaries"))).toBe(true);
	});

	it("lists an app's copy of a terminal session once, as the terminal's original", async () => {
		const own = writeSession(getDefaultSessionDir(project), "shared-id", project);
		writeSession(join(appStore, "omo-instance"), "shared-id", project);
		registerStore("omo-desktop-a.json", JSON.stringify({ version: 1, root: appStore }));

		const current = await currentScopeSessions(terminal());
		const all = await allScopeSessions(terminal());

		expect(current.map((session) => session.path)).toEqual([own]);
		expect(all.map((session) => session.path)).toEqual([own]);
	});
});
