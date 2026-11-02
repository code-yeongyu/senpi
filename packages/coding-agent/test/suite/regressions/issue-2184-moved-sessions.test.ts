import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listMovedSessions, markMovedSessions } from "../../../src/core/moved-sessions.ts";
import type { RepositoryIdentity } from "../../../src/core/repository-identity.ts";
import { listSessionsFromDir } from "../../../src/core/session-discovery.ts";
import { getDefaultSessionDir, SessionManager } from "../../../src/core/session-manager.ts";
import { SESSION_SUMMARY_INDEX_FILE } from "../../../src/core/session-summary-index-file.ts";
import { cleanupIssue2184, isolateAgentDir, RECORDED, tempDir, writeSession } from "./issue-2184-support.ts";

// Issue #2184: sessions of this repository recorded at a path that no longer exists are listed and
// marked "moved" wherever sessions are listed; other repositories and live checkouts are untouched.

beforeEach(isolateAgentDir);
afterEach(cleanupIssue2184);

const OTHER: RepositoryIdentity = { rootCommits: ["d".repeat(40)] };

function layout(sessionDir?: string) {
	const root = tempDir();
	const cwd = join(root, "new", "repo");
	const live = join(root, "clone", "repo");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(live, { recursive: true });
	const dirFor = (dir: string) => sessionDir ?? getDefaultSessionDir(dir);
	const gone = (name: string) => join(root, "gone", name);
	const files = {
		moved: writeSession(dirFor(gone("repo")), gone("repo"), {
			id: "0197f6e4-0000-7000-8000-000000000001",
			identity: RECORDED,
			text: "moved same repo",
		}),
		otherRepo: writeSession(dirFor(gone("other")), gone("other"), {
			id: "0197f6e4-0000-7000-8000-000000000002",
			identity: OTHER,
		}),
		unrecorded: writeSession(dirFor(gone("unrecorded")), gone("unrecorded"), {
			id: "0197f6e4-0000-7000-8000-000000000003",
		}),
		liveClone: writeSession(dirFor(live), live, { id: "0197f6e4-0000-7000-8000-000000000004", identity: RECORDED }),
		local: writeSession(dirFor(cwd), cwd, { id: "0197f6e4-0000-7000-8000-000000000005", identity: RECORDED }),
	};
	const readIdentity = async (dir: string) => (dir === cwd ? RECORDED : undefined);
	return { cwd, files, readIdentity, oldCwd: gone("repo") };
}

describe("issue #2184 moved sessions in session lists", () => {
	it("carries the recorded repository identity on every listed session", async () => {
		const { files } = layout();

		const [info] = await listSessionsFromDir(dirname(files.moved));

		expect(info?.repositoryIdentity).toEqual(RECORDED);
	});

	it("re-reads summaries cached by an index written before identities were recorded", async () => {
		const { files } = layout();
		const dir = dirname(files.moved);
		const stamp = statSync(files.moved);
		const stale = {
			file: basename(files.moved),
			size: stamp.size,
			mtimeMs: stamp.mtimeMs,
			summary: {
				header: {
					type: "session",
					version: 3,
					id: "0197f6e4-0000-7000-8000-000000000001",
					timestamp: "x",
					cwd: "",
				},
				firstUserMessage: "STALE",
				messageCount: 0,
				allMessagesText: "",
			},
		};
		writeFileSync(
			join(dir, SESSION_SUMMARY_INDEX_FILE),
			`${JSON.stringify({ version: 1 })}\n${JSON.stringify(stale)}\n`,
		);

		const [info] = await listSessionsFromDir(dir);

		expect(info?.firstMessage).toBe("moved same repo");
		expect(info?.repositoryIdentity).toEqual(RECORDED);
	});

	it("lists only same-repository sessions whose recorded path is gone, marked moved", async () => {
		const { cwd, files, readIdentity, oldCwd } = layout();

		const moved = await listMovedSessions(cwd, { readIdentity });

		expect(moved.map((session) => session.path)).toEqual([files.moved]);
		expect(moved[0]?.moved).toBe(true);
		expect(moved[0]?.cwd).toBe(oldCwd);
	});

	it("finds them in a shared --session-dir too", async () => {
		const sessionDir = join(tempDir(), "shared");
		const { cwd, files, readIdentity } = layout(sessionDir);

		const moved = await listMovedSessions(cwd, { sessionDir, readIdentity });

		expect(moved.map((session) => session.path)).toEqual([files.moved]);
	});

	it("marks the same session in the all-projects list and nothing else", async () => {
		const { cwd, files, readIdentity } = layout();

		const marked = await markMovedSessions(await SessionManager.listAll(), cwd, { readIdentity });

		expect(marked.filter((session) => session.moved).map((session) => session.path)).toEqual([files.moved]);
		expect(marked).toHaveLength(5);
	});

	it("lists nothing when the current directory is not a git repository", async () => {
		const { cwd } = layout();

		await expect(listMovedSessions(cwd, { readIdentity: async () => undefined })).resolves.toEqual([]);
	});
});
