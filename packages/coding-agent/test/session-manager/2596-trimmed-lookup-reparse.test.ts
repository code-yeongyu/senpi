import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../scripts/vitest-temp.ts";
import {
	loadEntriesFromFile,
	SessionManager,
	setSessionEntryLoaderForTesting,
} from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

function turn(session: SessionManager, n: number): string {
	const first = session.appendMessage(userMsg(`question ${n}`));
	session.appendMessage(assistantMsg(`answer ${n}`));
	return first;
}

describe("lookups outside a trimmed mirror parse the session file once per idle window (senpi#2596)", () => {
	let dir: string;
	let restoreLoader: (() => void) | undefined;
	let loads: number;

	beforeEach(() => {
		dir = makeTempDir(join(tmpdir(), "s2596-lookup-"));
		loads = 0;
		restoreLoader = setSessionEntryLoaderForTesting((file) => {
			loads++;
			return loadEntriesFromFile(file);
		});
	});

	afterEach(() => {
		restoreLoader?.();
	});

	function trimmedSession(): { session: SessionManager; early: string; reference: SessionManager } {
		const session = SessionManager.create(dir, dir);
		const early = turn(session, 1);
		turn(session, 2);
		session.appendCompaction("summary", turn(session, 3), 100);
		turn(session, 4);
		session.dropMaterializedCaches();
		const sessionFile = session.getSessionFile();
		if (sessionFile === undefined) throw new Error("a persisted session has a file");
		const reference = SessionManager.open(sessionFile, dir, dir);
		loads = 0;
		return { session, early, reference };
	}

	it("getEntry and getBranch for a pre-compaction id read the file once and return the persisted entry", () => {
		const { session, early, reference } = trimmedSession();
		const expectedBranch = reference.getBranch(early).map((entry) => entry.id);
		loads = 0;

		const first = session.getEntry(early);
		const second = session.getEntry(early);
		const branch = session.getBranch(early);

		expect(loads).toBe(1);
		expect(first?.id).toBe(early);
		expect(second).toEqual(first);
		expect(second).not.toBe(first);
		expect(branch.map((entry) => entry.id)).toEqual(expectedBranch);
	});

	it("keeps the parse across appends and re-reads only after the idle drop or for a newly trimmed id", () => {
		const { session, early } = trimmedSession();

		session.getEntry(early);
		turn(session, 5);
		expect(session.getEntry(early)?.id).toBe(early);
		expect(session.getEntry("no-such-entry")).toBeUndefined();
		expect(loads).toBe(1);

		session.dropMaterializedCaches();
		expect(session.getEntry(early)?.id).toBe(early);
		expect(loads).toBe(2);

		const keptAfterSecondTrim = turn(session, 6);
		const leftMirror = turn(session, 7);
		session.appendCompaction("second summary", turn(session, 8), 100);
		expect(session.getEntry(leftMirror)?.id).toBe(leftMirror);
		expect(session.getEntry(keptAfterSecondTrim)?.id).toBe(keptAfterSecondTrim);
		expect(loads).toBeLessThanOrEqual(3);
	});
});
