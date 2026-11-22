import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Args } from "../../../src/cli/args.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createSessionManager } from "../../../src/main.ts";
import { filterAndSortSessions } from "../../../src/modes/interactive/components/session-selector-search.ts";

// code-yeongyu/oh-my-openagent#7471: a session whose file name carries one id while its header
// carries another cannot be found by the id the file name (and the printed resume hint) names.

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-7471-")));
	tempDirs.push(dir);
	return dir;
}

function args(overrides: Partial<Args>): Args {
	return { messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [], ...overrides };
}

const FILE_ID = "01a048ce-c465-776b-959c-dcb362446db7";
const HEADER_ID = "01a048ce-c591-776d-92b2-cee77738c095";

/** The reporter's file: named after one id, header carrying another, 300 ms later. */
function writeDivergedSession(sessionDir: string, projectDir: string): string {
	const created = "2026-08-28T14:38:25.681Z";
	const path = join(sessionDir, `2026-08-28T14-38-25-381Z_${FILE_ID}.jsonl`);
	const lines = [
		{ type: "session", version: 3, id: HEADER_ID, timestamp: created, cwd: projectDir },
		{
			type: "message",
			id: "aaaaaaaa",
			parentId: null,
			timestamp: created,
			message: { role: "user", content: "hello", timestamp: Date.parse(created) },
		},
	];
	writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return path;
}

function headerId(path: string): string {
	return JSON.parse(readFileSync(path, "utf8").split("\n")[0] ?? "").id;
}

describe("session file name identity (oh-my-openagent#7471)", () => {
	it("a second writer opening a minted, not-yet-flushed path keeps the id the first one will print", () => {
		// How the reporter's file came to be: one manager mints `<ts>_<X>.jsonl` and holds X (the id its
		// exit hint prints) but writes nothing before the first reply; a second manager opens that path
		// while it does not exist yet and, before this fix, minted Y and wrote Y into the header.
		const root = tempDir();
		const projectDir = join(root, "project");
		const sessionDir = join(root, "sessions");
		mkdirSync(projectDir, { recursive: true });
		const minting = SessionManager.create(projectDir, sessionDir);
		const path = minting.getSessionFile();
		if (path === undefined) throw new Error("persisted manager has no session file");

		const writer = SessionManager.open(path, sessionDir, projectDir);
		writer.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		writer.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		expect(writer.getSessionId()).toBe(minting.getSessionId());
		expect(headerId(path)).toBe(minting.getSessionId());
	});

	it("--session-id opens the session whose file name carries the id instead of creating a second one", async () => {
		const root = tempDir();
		const projectDir = join(root, "project");
		const sessionDir = join(root, "sessions");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		const path = writeDivergedSession(sessionDir, projectDir);
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});

		const manager = await createSessionManager(
			args({ sessionId: FILE_ID }),
			projectDir,
			sessionDir,
			SettingsManager.inMemory(),
			"print",
		);

		expect(manager.getSessionFile()).toBe(path);
		expect(warn).not.toHaveBeenCalled();
		expect(headerId(path)).toBe(HEADER_ID);
	});

	it("the resume picker finds the session by the id its file name carries", async () => {
		const root = tempDir();
		const projectDir = join(root, "project");
		const sessionDir = join(root, "sessions");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		const path = writeDivergedSession(sessionDir, projectDir);

		const sessions = await SessionManager.list(projectDir, sessionDir);
		const found = filterAndSortSessions(sessions, FILE_ID, "relevance");

		expect(found.map((s) => s.path)).toEqual([path]);
	});

	it("creates a session at a named, not-yet-existing path under the id the name carries", () => {
		const root = tempDir();
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const path = join(sessionDir, `2026-08-28T14-38-25-381Z_${FILE_ID}.jsonl`);

		const manager = SessionManager.open(path, sessionDir, root);

		expect(manager.getSessionId()).toBe(FILE_ID);
	});

	it("resolves --session by the id in the file name when the header carries another id", async () => {
		const root = tempDir();
		const projectDir = join(root, "project");
		const sessionDir = join(root, "sessions");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		// 16 days old: no age cap exists, so a long-lived session must stay reachable.
		const path = writeDivergedSession(sessionDir, projectDir);

		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as never);
		vi.spyOn(console, "error").mockImplementation(() => {});

		for (const id of [FILE_ID, HEADER_ID]) {
			const manager = await createSessionManager(
				args({ session: id }),
				projectDir,
				sessionDir,
				SettingsManager.inMemory(),
				"print",
			);
			expect(manager.getSessionFile()).toBe(path);
		}
		expect(exit).not.toHaveBeenCalled();
		// Opening must not rewrite the recorded identity.
		expect(headerId(path)).toBe(HEADER_ID);
	});
});
