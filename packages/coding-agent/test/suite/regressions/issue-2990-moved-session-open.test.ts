import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { markMovedSessions, withMovedSessions } from "../../../src/core/moved-sessions.ts";
import { REPOSITORY_IDENTITY_ENTRY_TYPE, type RepositoryIdentity } from "../../../src/core/repository-identity.ts";
import { resolveResumeTarget } from "../../../src/core/resume-target.ts";
import { getDefaultSessionDir, SessionManager } from "../../../src/core/session-manager.ts";
import {
	breadcrumbBody,
	createMovedLayout,
	MOVED_SESSIONS,
	MOVED_WORKTREE,
	type MovedLayout,
	writeBreadcrumb,
} from "../moved-path-guard-fixtures.ts";

/**
 * code-yeongyu/senpi#2990: a session file the OmO desktop moved keeps the cwd it was recorded with in its header (the
 * desktop never rewrites session files). Opening it maps that cwd through the moved-path resolver (senpi#2898), so a
 * headless `--session` resume, `--continue` and `--resume` land in the folder's new home; only a trusted breadcrumb
 * that lists the folder maps it, and the session file stays byte-identical.
 */

const SESSION_ID = "0199f0d4-2990-7000-8000-000000000001";
const RECORDED: RepositoryIdentity = { rootCommits: ["a".repeat(40)] };

const layouts: MovedLayout[] = [];
afterEach(() => {
	while (layouts.length > 0) layouts.pop()?.cleanup();
});

function moved(options: Parameters<typeof createMovedLayout>[0] = {}) {
	const layout = createMovedLayout(options);
	layouts.push(layout);
	const sessionFile = writeMovedSession(join(layout.newSessions, "s.jsonl"), layout);
	return { layout, sessionFile, bytes: readFileSync(sessionFile) };
}

function writeMovedSession(sessionFile: string, layout: MovedLayout): string {
	const entries: unknown[] = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-10-07T00:00:00.000Z", cwd: layout.oldWorktree },
		{
			type: "custom",
			id: "r1",
			parentId: null,
			timestamp: "2026-10-07T00:00:01.000Z",
			customType: REPOSITORY_IDENTITY_ENTRY_TYPE,
			data: RECORDED,
		},
	];
	writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return sessionFile;
}

describe("issue #2990 a moved session opens in the folder's new home", () => {
	it("maps the header cwd and leaves the session file byte-identical", () => {
		const { layout, sessionFile, bytes } = moved();

		const manager = SessionManager.open(sessionFile);

		expect(manager.getCwd()).toBe(layout.newWorktree);
		expect(manager.getHeader()?.cwd).toBe(layout.oldWorktree);
		expect(readFileSync(sessionFile)).toEqual(bytes);
	});

	it.each([
		["a foreign kind", (layout: MovedLayout) => rewriteBreadcrumb(layout, { kind: "omo-desktop-something" })],
		["a newer schemaVersion", (layout: MovedLayout) => rewriteBreadcrumb(layout, { schemaVersion: 2 })],
		[
			"a homeId the new home's marker does not carry",
			(layout: MovedLayout) => rewriteBreadcrumb(layout, { homeId: "another-home" }),
		],
		["a worktree re-created with its own .git", (layout: MovedLayout) => reuseOldWorktree(layout)],
	])("keeps the recorded cwd for %s", (_label, change) => {
		const { layout, sessionFile, bytes } = moved();
		change(layout);

		expect(SessionManager.open(sessionFile).getCwd()).toBe(layout.oldWorktree);
		expect(readFileSync(sessionFile)).toEqual(bytes);
	});

	it("an explicit cwd override still wins", () => {
		const { layout, sessionFile } = moved();

		expect(SessionManager.open(sessionFile, undefined, layout.home).getCwd()).toBe(layout.home);
	});

	it("--continue with the moved session dir finds the session from the new folder", () => {
		const { layout, sessionFile } = moved();

		const recent = SessionManager.continueRecent(layout.newWorktree, layout.newSessions);

		expect(recent.getSessionFile()).toBe(sessionFile);
	});

	it("--session <id> with the moved session dir finds the session from the new folder", () => {
		const { layout, sessionFile } = moved();

		expect(SessionManager.findById(layout.newWorktree, SESSION_ID, layout.newSessions)).toBe(sessionFile);
	});

	// Review M1: the picker shows a desktop-moved session once, as this folder's own session, never also as a moved one.
	it("the current-scope resume picker lists the moved session once, unbadged", async () => {
		const { layout, sessionFile } = moved();

		const rows = await withMovedSessions(
			SessionManager.list(layout.newWorktree, layout.newSessions),
			layout.newWorktree,
			{
				sessionDir: layout.newSessions,
				readIdentity: async () => RECORDED,
			},
		);

		expect(rows.map((row) => [row.path, row.moved === true])).toEqual([[sessionFile, false]]);
	});

	// Round-2 review H1: without a session dir the session sits in the old folder's default dir, which only the moved
	// lookup reaches; it must still be listed, once and unbadged.
	it("the current-scope resume picker lists the moved session once in the default per-folder layout", async () => {
		const layout = createMovedLayout();
		layouts.push(layout);
		const inherited = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(layout.home, "agent");
		try {
			const sessionFile = writeMovedSession(join(getDefaultSessionDir(layout.oldWorktree), "s.jsonl"), layout);

			const current = await withMovedSessions(SessionManager.list(layout.newWorktree), layout.newWorktree, {
				readIdentity: async () => RECORDED,
			});
			const all = await markMovedSessions(await SessionManager.listAll(), layout.newWorktree, {
				readIdentity: async () => RECORDED,
			});

			expect(current.map((row) => [row.path, row.moved === true])).toEqual([[sessionFile, false]]);
			expect(all.map((row) => [row.path, row.moved === true])).toEqual([[sessionFile, false]]);
		} finally {
			if (inherited === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = inherited;
		}
	});

	it("the all-scope resume picker does not badge the moved session as moved", async () => {
		const { layout, sessionFile } = moved();

		const rows = await markMovedSessions(await SessionManager.listAll(layout.newSessions), layout.newWorktree, {
			readIdentity: async () => RECORDED,
		});

		expect(rows.map((row) => [row.path, row.moved === true])).toEqual([[sessionFile, false]]);
	});

	it("--resume of the moved session from the new folder opens it as is, without a rebind question", async () => {
		const { layout, sessionFile, bytes } = moved();

		const target = await resolveResumeTarget({
			sessionPath: sessionFile,
			cwd: layout.newWorktree,
			readIdentity: async () => RECORDED,
			confirm: async (sessionCwd) => {
				throw new Error(`asked to rebind a session recorded at ${sessionCwd}`);
			},
		});

		expect(target).toEqual({ path: sessionFile, rebound: false });
		expect(SessionManager.open(target.path).getCwd()).toBe(layout.newWorktree);
		expect(readFileSync(sessionFile)).toEqual(bytes);
	});
});

function rewriteBreadcrumb(layout: MovedLayout, override: Record<string, unknown>): void {
	writeBreadcrumb(layout.oldRoot, {
		...breadcrumbBody(layout.newRoot, [MOVED_WORKTREE, MOVED_SESSIONS]),
		...override,
	});
}

function reuseOldWorktree(layout: MovedLayout): void {
	mkdirSync(layout.oldWorktree, { recursive: true });
	writeFileSync(join(layout.oldWorktree, ".git"), "gitdir: /elsewhere/.git/worktrees/w1\n");
}
