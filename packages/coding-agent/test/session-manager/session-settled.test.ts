import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSessionSettled, readSessionSettled, setSessionSettled } from "../../src/core/session-settled.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

function persisted(file: string | undefined): string {
	if (file === undefined) throw new Error("expected a persisted session file");
	return file;
}

const LARGE_TEXT = "x".repeat(256 * 1024);

describe("a session's settled (Done) flag", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `session-settled-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** A persisted session settled by a merged PR before a compaction whose window leaves the early turns out. */
	function settledCompactedSession() {
		const session = SessionManager.create(dir, dir);
		session.appendModelChange("anthropic", "test");
		session.appendMessage(userMsg(`early ${LARGE_TEXT}`));
		session.appendMessage(assistantMsg(`early answer ${LARGE_TEXT}`));
		setSessionSettled(session, { settled: true, by: { kind: "pr-merged", pullRequestNumber: 42 } });
		const firstKept = session.appendMessage(userMsg("kept request"));
		session.appendMessage(assistantMsg("kept answer"));
		session.appendCompaction("summary of the early work", firstKept, 1000);
		const tip = session.appendMessage(userMsg("after compaction"));
		return { session, tip, file: persisted(session.getSessionFile()) };
	}

	it("writes { settled, by, at, sessionId } and reads back with its by after a reopen, without the history", () => {
		const { session, file } = settledCompactedSession();
		const entry = session
			.getEntries()
			.find((candidate) => candidate.type === "custom" && candidate.customType === "session_settled");
		expect(entry?.type === "custom" ? entry.data : undefined).toEqual({
			settled: true,
			by: { kind: "pr-merged", pullRequestNumber: 42 },
			at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
			sessionId: session.getSessionId(),
		});

		const reopened = SessionManager.open(file, dir);
		reopened.dropMaterializedCaches();
		expect(readSessionSettled(reopened)).toEqual({ settled: true, by: { kind: "pr-merged", pullRequestNumber: 42 } });
		expect(reopened.holdsMaterializedHistory()).toBe(false);
	});

	it("follows the newest entry: settling by the user, then reopening the thread, sticks across a reopen", () => {
		const { session, file } = settledCompactedSession();

		setSessionSettled(session, { settled: true, by: { kind: "user" } });
		expect(readSessionSettled(SessionManager.open(file, dir))).toEqual({ settled: true, by: { kind: "user" } });

		setSessionSettled(session, { settled: false });
		expect(readSessionSettled(session)).toEqual({ settled: false });
		expect(readSessionSettled(SessionManager.open(file, dir))).toEqual({ settled: false });
	});

	it("is not inherited by a fork or a branch, and the source keeps it", () => {
		const { session, tip, file } = settledCompactedSession();

		const fork = SessionManager.forkFrom(file, dir, dir);
		expect(readSessionSettled(fork)).toEqual({ settled: false });
		setSessionSettled(fork, { settled: true, by: { kind: "agent" } });
		expect(readSessionSettled(SessionManager.open(persisted(fork.getSessionFile()), dir))).toEqual({
			settled: true,
			by: { kind: "agent" },
		});

		const branchFile = session.createBranchedSession(tip);
		expect(readSessionSettled(SessionManager.open(persisted(branchFile), dir))).toEqual({ settled: false });
		expect(readSessionSettled(SessionManager.open(file, dir))).toMatchObject({ settled: true });
	});

	it("starts not settled", () => {
		expect(readSessionSettled(SessionManager.create(dir, dir))).toEqual({ settled: false });
	});
});

describe("the set_session_settled arguments mirror the desktop's ThreadSettledBy", () => {
	it("accepts every kind, trimming strings and dropping fields the kind does not carry", () => {
		expect(parseSessionSettled({ settled: true, by: { kind: "user" } })).toEqual({
			ok: true,
			value: { settled: true, by: { kind: "user" } },
		});
		expect(
			parseSessionSettled({
				settled: true,
				by: { kind: "agent", threadId: " thread-1 ", threadTitle: "Fix the build", extra: 1 },
			}),
		).toEqual({
			ok: true,
			value: { settled: true, by: { kind: "agent", threadId: "thread-1", threadTitle: "Fix the build" } },
		});
		expect(parseSessionSettled({ settled: true, by: { kind: "pr-closed" } })).toEqual({
			ok: true,
			value: { settled: true, by: { kind: "pr-closed" } },
		});
		expect(parseSessionSettled({ settled: true, by: { kind: "inactivity", days: 0 } })).toEqual({
			ok: true,
			value: { settled: true, by: { kind: "inactivity", days: 0 } },
		});
		expect(parseSessionSettled({ settled: true })).toEqual({ ok: true, value: { settled: true } });
		expect(parseSessionSettled({ settled: false, by: { kind: "user" } })).toEqual({
			ok: true,
			value: { settled: false },
		});
	});

	it("refuses an unknown kind and every malformed by, without echoing the value", () => {
		for (const by of [
			{ kind: "goal-complete" },
			{ kind: "inactivity" },
			{ kind: "inactivity", days: -1 },
			{ kind: "inactivity", days: 1.5 },
			{ kind: "pr-merged", pullRequestNumber: 0 },
			{ kind: "pr-merged", pullRequestNumber: "7" },
			{ kind: "agent", threadTitle: "   " },
			"user",
			null,
		]) {
			const parsed = parseSessionSettled({ settled: true, by });
			expect(parsed.ok, JSON.stringify(by)).toBe(false);
			if (!parsed.ok) expect(parsed.error).not.toContain("goal-complete");
		}
		expect(parseSessionSettled({ settled: "yes" }).ok).toBe(false);
	});
});
