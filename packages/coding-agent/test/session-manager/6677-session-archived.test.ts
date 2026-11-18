import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSessionArchived, setSessionArchived } from "../../src/core/session-archived.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

function persisted(file: string | undefined): string {
	if (file === undefined) throw new Error("expected a persisted session file");
	return file;
}

const LARGE_TEXT = "x".repeat(256 * 1024);

describe("a session's archived flag (senpi#6677)", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `session-archived-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** A persisted session archived before a compaction whose window leaves the early turns out. */
	function archivedCompactedSession() {
		const session = SessionManager.create(dir, dir);
		session.appendModelChange("anthropic", "test");
		session.appendMessage(userMsg(`early ${LARGE_TEXT}`));
		session.appendMessage(assistantMsg(`early answer ${LARGE_TEXT}`));
		setSessionArchived(session, true);
		const firstKept = session.appendMessage(userMsg("kept request"));
		session.appendMessage(assistantMsg("kept answer"));
		session.appendCompaction("summary of the early work", firstKept, 1000);
		const tip = session.appendMessage(userMsg("after compaction"));
		return { session, tip, file: persisted(session.getSessionFile()) };
	}

	it("is read on a trimmed mirror without materializing the history, live and after a reopen", () => {
		const { session, file } = archivedCompactedSession();
		session.dropMaterializedCaches();
		expect(session.holdsMaterializedHistory()).toBe(false);

		expect(isSessionArchived(session)).toBe(true);
		expect(session.holdsMaterializedHistory()).toBe(false);

		const reopened = SessionManager.open(file, dir);
		reopened.dropMaterializedCaches();

		expect(isSessionArchived(reopened)).toBe(true);
		expect(reopened.holdsMaterializedHistory()).toBe(false);
		// The mirror really is trimmed: a full-history read does hold the history.
		reopened.getEntries();
		expect(reopened.holdsMaterializedHistory()).toBe(true);
	});

	it("follows the newest entry, and unarchiving a trimmed session sticks across a reopen", () => {
		const { session, file } = archivedCompactedSession();

		setSessionArchived(session, false);

		expect(isSessionArchived(session)).toBe(false);
		expect(isSessionArchived(SessionManager.open(file, dir))).toBe(false);
	});

	it("is not inherited by a branch made with createBranchedSession, and the source keeps it", () => {
		const { session, tip, file } = archivedCompactedSession();

		const branchFile = session.createBranchedSession(tip);

		expect(branchFile).not.toBe(file);
		expect(isSessionArchived(session)).toBe(false);
		expect(isSessionArchived(SessionManager.open(persisted(branchFile), dir))).toBe(false);
		expect(isSessionArchived(SessionManager.open(file, dir))).toBe(true);
	});

	it("is not inherited by a fork (forkFrom), which can still be archived on its own", () => {
		const { file } = archivedCompactedSession();

		const fork = SessionManager.forkFrom(file, dir, dir);

		expect(isSessionArchived(fork)).toBe(false);
		setSessionArchived(fork, true);
		expect(isSessionArchived(SessionManager.open(persisted(fork.getSessionFile()), dir))).toBe(true);
		expect(isSessionArchived(SessionManager.open(file, dir))).toBe(true);
	});
});
