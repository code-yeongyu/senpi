import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { withMovedSessions } from "../../../src/core/moved-sessions.ts";
import { readRepositoryIdentity } from "../../../src/core/repository-identity.ts";
import { listSessionsFromDir } from "../../../src/core/session-discovery.ts";
import { getDefaultSessionDir, SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createSessionManager } from "../../../src/main.ts";
import { createMovedLayout, type MovedLayout, writeSessionHeader } from "../moved-path-guard-fixtures.ts";

// The real implementations stay; the mocks only count how often --continue lists session dirs or asks git.
vi.mock("../../../src/core/repository-identity.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/core/repository-identity.ts")>();
	return { ...actual, readRepositoryIdentity: vi.fn(actual.readRepositoryIdentity) };
});
vi.mock("../../../src/core/session-discovery.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/core/session-discovery.ts")>();
	return { ...actual, listSessionsFromDir: vi.fn(actual.listSessionsFromDir) };
});
// Every readdir reaches disk except the one dir a test makes fail with a chosen errno.
const readdirFault = vi.hoisted(() => ({ dir: "", code: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		readdir: (...args: Parameters<typeof actual.readdir>) => {
			if (readdirFault.dir !== "" && args[0] === readdirFault.dir) {
				return Promise.reject(
					Object.assign(new Error(`${readdirFault.code}: injected`), { code: readdirFault.code }),
				);
			}
			return actual.readdir(...args);
		},
	};
});

/**
 * code-yeongyu/senpi#2990 review round 4: in the default per-folder layout `--continue` compares the folder's own
 * newest session with the newest one the OmO desktop moved here. Finding those must not cost the folder anything
 * else: no git identity read and no listing of unrelated vanished project dirs (M2), no failure on an unreadable
 * dir (L4), and no git requirement at all, since a trusted breadcrumb already decides (L1).
 */

const identityReads = vi.mocked(readRepositoryIdentity);
const dirListings = vi.mocked(listSessionsFromDir);
const OLD = new Date("2026-10-01T00:00:00Z");
const NEW = new Date("2026-10-08T00:00:00Z");
const DEAD_PROJECTS = 5;

let layout: MovedLayout;
let inherited: string | undefined;
beforeEach(() => {
	layout = createMovedLayout();
	inherited = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = join(layout.home, "agent");
	for (let index = 0; index < DEAD_PROJECTS; index++) {
		const gone = join(layout.home, "gone", String(index));
		writeSessionHeader(
			join(getDefaultSessionDir(gone), "dead.jsonl"),
			`0199f0d4-2990-7000-8000-00000000d00${index}`,
			gone,
		);
	}
});
afterEach(() => {
	readdirFault.dir = "";
	readdirFault.code = "";
	if (inherited === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = inherited;
	layout.cleanup();
});

function session(cwd: string, name: string, mtime: Date): string {
	const file = join(getDefaultSessionDir(cwd), `${name}.jsonl`);
	writeSessionHeader(file, `0199f0d4-2990-7000-8000-0000000${name === "own" ? "00a01" : "00b01"}`, cwd);
	utimesSync(file, mtime, mtime);
	return file;
}

async function continueFrom(cwd: string): Promise<string | undefined> {
	identityReads.mockClear();
	dirListings.mockClear();
	const manager = await createSessionManager(
		parseArgs(["--continue"]),
		cwd,
		undefined,
		SettingsManager.inMemory(),
		"print",
	);
	return manager.getSessionFile();
}

describe("issue #2990 --continue looks only at sessions moved here", () => {
	it("a folder with its own session lists no vanished dir and never asks git", async () => {
		const own = session(layout.newWorktree, "own", NEW);

		expect(await continueFrom(layout.newWorktree)).toBe(own);
		expect(identityReads).not.toHaveBeenCalled();
		expect(dirListings).not.toHaveBeenCalled();
	});

	it("lists only the dir whose recorded folder moved here, without git", async () => {
		session(layout.newWorktree, "own", OLD);
		const moved = session(layout.oldWorktree, "moved", NEW);

		expect(await continueFrom(layout.newWorktree)).toBe(moved);
		expect(identityReads).not.toHaveBeenCalled();
		expect(dirListings.mock.calls.map(([dir]) => dir)).toEqual([getDefaultSessionDir(layout.oldWorktree)]);
	});

	it("the resume picker of a folder without git still lists the session moved here, once", async () => {
		const moved = session(layout.oldWorktree, "moved", NEW);

		const rows = await withMovedSessions(SessionManager.list(layout.newWorktree), layout.newWorktree);

		expect(rows.map((row) => [row.path, row.moved === true])).toEqual([[moved, false]]);
	});

	it("a session dir that vanished mid-scan is skipped", async () => {
		const own = session(layout.newWorktree, "own", NEW);
		readdirFault.dir = getDefaultSessionDir(join(layout.home, "gone", "0"));
		readdirFault.code = "ENOENT";

		expect(await continueFrom(layout.newWorktree)).toBe(own);
		await expect(withMovedSessions(SessionManager.list(layout.newWorktree), layout.newWorktree)).resolves.toEqual([
			expect.objectContaining({ path: own }),
		]);
	});

	it("an I/O fault on an unrelated session dir never blocks --continue or the picker of this folder", async () => {
		const own = session(layout.newWorktree, "own", NEW);
		readdirFault.dir = getDefaultSessionDir(join(layout.home, "gone", "0"));
		readdirFault.code = "EIO";

		expect(await continueFrom(layout.newWorktree)).toBe(own);
		await expect(withMovedSessions(SessionManager.list(layout.newWorktree), layout.newWorktree)).resolves.toEqual([
			expect.objectContaining({ path: own }),
		]);
	});

	it("the picker of a shared session dir lists that dir once", async () => {
		const sessionDir = join(layout.home, "shared");
		const own = join(sessionDir, "own.jsonl");
		const moved = join(sessionDir, "moved.jsonl");
		mkdirSync(sessionDir, { recursive: true });
		writeSessionHeader(own, "0199f0d4-2990-7000-8000-0000000c0a01", layout.newWorktree);
		writeSessionHeader(moved, "0199f0d4-2990-7000-8000-0000000c0b01", layout.oldWorktree);
		utimesSync(own, OLD, OLD);
		utimesSync(moved, NEW, NEW);
		dirListings.mockClear();

		const rows = await withMovedSessions(SessionManager.list(layout.newWorktree, sessionDir), layout.newWorktree, {
			sessionDir,
		});

		expect(rows.map((row) => [row.path, row.moved === true])).toEqual([
			[moved, false],
			[own, false],
		]);
		expect(dirListings).toHaveBeenCalledTimes(1);
	});

	describe.runIf(process.platform !== "win32" && process.getuid?.() !== 0)("an unreadable session dir", () => {
		it("is skipped by --continue and the picker instead of failing them", async () => {
			// A repository, so the moved-repository lookup (senpi#2184) has an identity and scans the vanished dirs too.
			const identity = {
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			};
			for (const args of [
				["init", "-q"],
				["commit", "-q", "--allow-empty", "-m", "init"],
			])
				execFileSync("git", args, { cwd: layout.newWorktree, env: { ...process.env, ...identity } });
			const own = session(layout.newWorktree, "own", NEW);
			const unreadable = getDefaultSessionDir(join(layout.home, "gone", "0"));
			chmodSync(unreadable, 0o000);
			try {
				expect(await continueFrom(layout.newWorktree)).toBe(own);
				await expect(
					withMovedSessions(SessionManager.list(layout.newWorktree), layout.newWorktree),
				).resolves.toEqual([expect.objectContaining({ path: own })]);
			} finally {
				chmodSync(unreadable, 0o700);
			}
		});
	});
});
