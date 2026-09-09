import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SessionResumeConflictError } from "../../../src/core/session-resume-conflict.ts";
import * as reservations from "../../../src/core/session-write-reservation.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "prepared-writers-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const path = join(cwd, "target.jsonl");
	const bytes = JSON.stringify({
		type: "session",
		version: 3,
		id: "target",
		timestamp: new Date(0).toISOString(),
		cwd,
	});
	writeFileSync(path, bytes);
	return { cwd, path, bytes };
}

// PR #1473: all instance entry points must preserve the prepared manager's deferred ownership.
it.each(["open", "set", "new", "branch", "write", "reload"])(
	"defers writer ownership through prepared %s and reserves only the actual accepted destination",
	(operation) => {
		const { cwd, path, bytes } = fixture();
		const reserve = vi.spyOn(reservations, "reserveSessionWrite");
		const prepared = SessionManager.prepareOpen(path);
		const manager = prepared.sessionManager;
		switch (operation) {
			case "set": {
				const other = join(cwd, "other.jsonl");
				writeFileSync(other, bytes);
				manager.setSessionFile(other);
				break;
			}
			case "new":
				manager.newSession();
				break;
			case "branch": {
				const leaf = manager.appendMessage(fauxAssistantMessage("stored"));
				manager.createBranchedSession(leaf);
				break;
			}
			case "write":
				manager.appendMessage(fauxAssistantMessage("stored"));
				break;
			case "reload":
				manager.reloadFromDisk();
				break;
			case "open":
				break;
		}
		expect(reserve).not.toHaveBeenCalled();
		expect(readFileSync(path, "utf8")).toBe(bytes);
		const acceptance = prepared.beginCommit();
		expect(reserve).toHaveBeenCalledExactlyOnceWith(manager.getSessionFile());
		expect(readFileSync(path, "utf8")).toBe(bytes);
		acceptance.commit();
	},
);

it("revalidates the accepted destination and releases the grant when its snapshot changed", () => {
	const { path, bytes } = fixture();
	const prepared = SessionManager.prepareOpen(path);
	const release = vi.fn();
	vi.spyOn(reservations, "reserveSessionWrite").mockReturnValue(release);
	writeFileSync(path, `${bytes}\n`);
	expect(() => prepared.beginCommit()).toThrow("Session file changed while preparing resume");
	expect(release).toHaveBeenCalledOnce();
	expect(readFileSync(path, "utf8")).toBe(`${bytes}\n`);
});

it("releases the acceptance grant on cancellation without writing the target", () => {
	const { path, bytes } = fixture();
	const prepared = SessionManager.prepareOpen(path);
	const release = vi.fn();
	vi.spyOn(reservations, "reserveSessionWrite").mockReturnValue(release);
	const acceptance = prepared.beginCommit();
	acceptance.rollback();
	expect(release).toHaveBeenCalledOnce();
	expect(readFileSync(path, "utf8")).toBe(bytes);
});

// PR #1473 ghN2H: awaited veto handlers can change the destination after the first grant check.
it.each(["normal", "legacy", "empty", "missing"])(
	"PR1473 ghN2H: commit rejects a target changed after beginCommit (%s)",
	(kind) => {
		const { path, bytes } = fixture();
		if (kind === "legacy") writeFileSync(path, bytes.replace('"version":3', '"version":1'));
		if (kind === "empty") writeFileSync(path, "");
		if (kind === "missing") rmSync(path);
		const prepared = SessionManager.prepareOpen(path);
		prepared.sessionManager.appendMessage(fauxAssistantMessage("candidate-only"));
		const release = vi.fn();
		vi.spyOn(reservations, "reserveSessionWrite").mockReturnValue(release);
		const acceptance = prepared.beginCommit();
		const changed = `${bytes}\n${JSON.stringify({ type: "session_info", id: "external", parentId: null, timestamp: new Date(0).toISOString(), name: "external-write" })}\n`;
		writeFileSync(path, changed);
		let failure: unknown;
		try {
			acceptance.commit();
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SessionResumeConflictError);
		expect(failure).toMatchObject({ sessionFile: path });
		expect(readFileSync(path, "utf8")).toBe(changed);
		expect(release).toHaveBeenCalledOnce();
		acceptance.rollback();
		expect(release).toHaveBeenCalledOnce();
	},
);
