import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPOSITORY_IDENTITY_ENTRY_TYPE, type RepositoryIdentity } from "../../../src/core/repository-identity.ts";
import { getDefaultSessionDir, SessionManager } from "../../../src/core/session-manager.ts";
import { classifySessionRepository, rebindSessionFile } from "../../../src/core/session-rebind.ts";

const SESSION_ID = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3";
const ROOT = "c".repeat(40);
const RECORDED: RepositoryIdentity = { rootCommits: [ROOT] };
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-rebind-")));
	tempDirs.push(dir);
	return dir;
}

function historyLines(identity: RepositoryIdentity | undefined): string[] {
	const lines = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-09-27T00:00:01.000Z",
			message: { role: "user", content: "remember 42", timestamp: 1 },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-09-27T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "42 noted" }],
				api: "faux",
				provider: "faux",
				model: "faux",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		},
	];
	const recorded = identity
		? [
				{
					type: "custom",
					id: "r1",
					parentId: "a1",
					timestamp: "2026-09-27T00:00:03.000Z",
					customType: REPOSITORY_IDENTITY_ENTRY_TYPE,
					data: identity,
				},
			]
		: [];
	return [...lines, ...recorded].map((entry) => JSON.stringify(entry));
}

function writeSession(sessionDir: string, cwd: string, identity?: RepositoryIdentity): string {
	mkdirSync(sessionDir, { recursive: true });
	const file = join(sessionDir, `2026-09-27T00-00-00-000Z_${SESSION_ID}.jsonl`);
	const header = { type: "session", version: 3, id: SESSION_ID, timestamp: "2026-09-27T00:00:00.000Z", cwd };
	writeFileSync(file, `${[JSON.stringify(header), ...historyLines(identity)].join("\n")}\n`);
	return file;
}

describe("issue #2181 rebinding a session into a moved repository", () => {
	it("moves the session under the new project, keeps its id and history, and drops it from the old project", async () => {
		const root = tempDir();
		const oldCwd = join(root, "old", "repo");
		const newCwd = join(root, "new", "repo");
		mkdirSync(newCwd, { recursive: true });
		const source = writeSession(getDefaultSessionDir(oldCwd), oldCwd, RECORDED);
		const goalSidecar = join(dirname(source), "extensions", "goal", `${SESSION_ID}.json`);
		mkdirSync(dirname(goalSidecar), { recursive: true });
		writeFileSync(goalSidecar, '{"goal":"ship"}\n');
		const sourceHistory = readFileSync(source, "utf8").split("\n").slice(1).join("\n");

		const rebound = await rebindSessionFile(source, newCwd);

		expect(dirname(rebound)).toBe(getDefaultSessionDir(newCwd));
		expect(basename(rebound)).toBe(basename(source));
		expect(existsSync(source)).toBe(false);
		const [headerLine, ...rest] = readFileSync(rebound, "utf8").split("\n");
		expect(JSON.parse(headerLine ?? "")).toMatchObject({ type: "session", id: SESSION_ID, cwd: newCwd });
		expect(rest.join("\n")).toBe(sourceHistory);
		expect(readFileSync(join(dirname(rebound), "extensions", "goal", `${SESSION_ID}.json`), "utf8")).toBe(
			'{"goal":"ship"}\n',
		);
		expect(existsSync(goalSidecar)).toBe(false);

		expect((await SessionManager.list(oldCwd)).map((session) => session.id)).not.toContain(SESSION_ID);
		expect((await SessionManager.list(newCwd)).map((session) => session.id)).toContain(SESSION_ID);
		const reopened = SessionManager.open(rebound);
		expect(reopened.getSessionId()).toBe(SESSION_ID);
		expect(reopened.getCwd()).toBe(newCwd);
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual(["u1", "a1", "r1"]);
	});

	it("rewrites the header in place when every project shares one session directory", async () => {
		const root = tempDir();
		const sessionDir = join(root, "sessions");
		const source = writeSession(sessionDir, join(root, "old"));

		const rebound = await rebindSessionFile(source, join(root, "new"), sessionDir);

		expect(rebound).toBe(source);
		expect(JSON.parse(readFileSync(rebound, "utf8").split("\n")[0] ?? "")).toMatchObject({ cwd: join(root, "new") });
	});

	it("refuses to overwrite a session already filed under the target project", async () => {
		const root = tempDir();
		const oldCwd = join(root, "old");
		const newCwd = join(root, "new");
		const source = writeSession(getDefaultSessionDir(oldCwd), oldCwd);
		writeSession(getDefaultSessionDir(newCwd), newCwd);

		await expect(rebindSessionFile(source, newCwd)).rejects.toThrow(/already exists/);
		expect(existsSync(source)).toBe(true);
	});

	it("recognises a moved repository from the identity the session recorded", async () => {
		const root = tempDir();
		const newCwd = join(root, "new");
		const read = async (dir: string) => (dir === newCwd ? RECORDED : undefined);
		const recorded = writeSession(join(root, "a"), join(root, "gone"), RECORDED);
		const legacy = writeSession(join(root, "b"), join(root, "gone"));
		const other = writeSession(join(root, "c"), join(root, "gone"), { rootCommits: ["d".repeat(40)] });

		expect(await classifySessionRepository(recorded, join(root, "gone"), newCwd, read)).toBe("same");
		expect(await classifySessionRepository(legacy, join(root, "gone"), newCwd, read)).toBe("unknown");
		expect(await classifySessionRepository(other, join(root, "gone"), newCwd, read)).toBe("different");
	});

	it("asks the live checkout when the recorded path still exists", async () => {
		const root = tempDir();
		const oldCwd = join(root, "old");
		const newCwd = join(root, "new");
		mkdirSync(oldCwd, { recursive: true });
		const session = writeSession(join(root, "s"), oldCwd, RECORDED);
		const read = async (dir: string) => (dir === oldCwd ? { rootCommits: ["e".repeat(40)] } : RECORDED);

		expect(await classifySessionRepository(session, oldCwd, newCwd, read)).toBe("different");
	});
});
