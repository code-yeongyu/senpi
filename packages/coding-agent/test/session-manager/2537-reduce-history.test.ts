import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../scripts/vitest-temp.ts";
import type { HistoryReducer } from "../../src/core/session-history-reduce.ts";
import {
	loadEntriesFromFile,
	SessionManager,
	setSessionEntryLoaderForTesting,
} from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

function idsReducer(): HistoryReducer<string[]> {
	return {
		initial: () => [],
		add: (ids, entry) => {
			ids.push(entry.id);
			return ids;
		},
	};
}

function turn(session: SessionManager, n: number): string {
	const first = session.appendMessage(userMsg(`question ${n}`));
	session.appendCustomEntry("note", { n });
	session.appendMessage(assistantMsg(`answer ${n}`));
	return first;
}

describe("SessionManager.reduceHistory folds the whole history without a full-history view (senpi#2537)", () => {
	let dir: string;
	let restoreLoader: (() => void) | undefined;
	let loads: number;

	beforeEach(() => {
		dir = makeTempDir(join(tmpdir(), "s2537-reduce-"));
		loads = 0;
		restoreLoader = setSessionEntryLoaderForTesting((file) => {
			loads++;
			return loadEntriesFromFile(file);
		});
	});

	afterEach(() => {
		restoreLoader?.();
	});

	function expectSameAsEntries(session: SessionManager, reducer: HistoryReducer<string[]>): void {
		const folded = [...session.reduceHistory(reducer)];
		session.dropMaterializedCaches();
		expect(folded).toEqual(session.getEntries().map((entry) => entry.id));
		session.dropMaterializedCaches();
	}

	it("matches getEntries() through appends, live compactions, a reopen and a branch to a trimmed entry", () => {
		const session = SessionManager.create(dir, dir);
		const reducer = idsReducer();
		const early = turn(session, 1);
		turn(session, 2);
		expectSameAsEntries(session, reducer);

		session.appendCompaction("first summary", turn(session, 3), 100);
		turn(session, 4);
		expectSameAsEntries(session, reducer);

		const kept = turn(session, 5);
		turn(session, 6);
		session.appendCompaction("second summary", kept, 100);
		turn(session, 7);
		expectSameAsEntries(session, reducer);

		const reopened = SessionManager.open(session.getSessionFile()!, dir, dir);
		const reopenedReducer = idsReducer();
		expectSameAsEntries(reopened, reopenedReducer);
		turn(reopened, 8);
		expectSameAsEntries(reopened, reopenedReducer);

		reopened.branch(early);
		turn(reopened, 9);
		expectSameAsEntries(reopened, reopenedReducer);
	});

	it("reads a compacted session's file once, then folds only appended entries, and holds no history view", () => {
		const session = SessionManager.create(dir, dir);
		turn(session, 1);
		session.appendCompaction("summary", turn(session, 2), 100);
		session.dropMaterializedCaches();
		const reducer = idsReducer();
		loads = 0;

		session.reduceHistory(reducer);
		for (let n = 3; n <= 6; n++) {
			turn(session, n);
			session.reduceHistory(reducer);
		}

		expect(loads).toBe(1);
		expect(session.holdsMaterializedHistory()).toBe(false);
		expect(session.reduceHistory(reducer)).toHaveLength(session.getEntryCount());
	});

	it("never applies an entry twice after a reducer threw partway through new entries", () => {
		const session = SessionManager.create(dir, dir);
		let armed = false;
		const reducer: HistoryReducer<string[]> = {
			initial: () => [],
			add: (ids, entry) => {
				if (armed && entry.type === "custom" && entry.customType === "boom") throw new Error("reducer failed");
				ids.push(entry.id);
				return ids;
			},
		};
		turn(session, 1);
		session.reduceHistory(reducer);
		turn(session, 2);
		session.appendCustomEntry("boom");

		armed = true;
		expect(() => session.reduceHistory(reducer)).toThrow("reducer failed");
		armed = false;

		expectSameAsEntries(session, reducer);
	});

	it("starts over when the session is replaced", () => {
		const session = SessionManager.create(dir, dir);
		const reducer = idsReducer();
		turn(session, 1);
		expect(session.reduceHistory(reducer)).toHaveLength(3);

		session.newSession();
		turn(session, 2);

		expectSameAsEntries(session, reducer);
	});
});
