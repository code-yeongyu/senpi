import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { getDefaultSessionDir, getDefaultSessionDirPath, SessionManager } from "../../../src/core/session-manager.ts";
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
	getSessionDir: () => getDefaultSessionDirPath(project),
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
});
