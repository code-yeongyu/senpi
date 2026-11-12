/**
 * senpi#6435 with senpi#6417: the commit stamp of a move that was readied for a folder. The commit that re-checks its
 * lock writes the stamp, and the rule that leaves a young stamp unsettled reads it back and later settles it. Both
 * must keep the folder: the record on disk is a storage contract, and every writer of it keeps the field `cwd`.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";

const LANDING = "/sessions/landing.jsonl";
const FOLDER = "/work/one";
const MOVE = "stamp-1" as MoveId;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a commit stamp keeps the folder its move was readied for (senpi#6435, senpi#6417)", () => {
	it("#given a move readied for a folder whose commit stamped it and stopped at the rename #when the sender asks while no file is there, right after the stamp, and again once the file is there #then the stamp holds the folder and is not failed while young, and the accepted record still holds the folder", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-move-stamp-")));
		dirs.push(dir);
		const clock = { now: 1_000_000 };
		const book = new MoveLedger(dir, { now: () => clock.now });
		const stored = () => JSON.parse(readFileSync(join(dir, `${MOVE}.json`), "utf8")) as Record<string, unknown>;
		const stamped = { state: "receiving", committing: true, target: LANDING, cwd: FOLDER };
		await book.prepare(MOVE, FOLDER);
		await book.beginReceive(MOVE, LANDING, { cwd: FOLDER });
		const stopping = () => {
			throw new Error("the rename stopped");
		};
		await expect(book.commit(MOVE, LANDING, stopping)).rejects.toThrow("the rename stopped");
		expect(stored()).toMatchObject(stamped);

		// The stamp carries the time it was written; the ledger's clock is set from it, so no real time passes here.
		clock.now = Date.parse(String(stored().at)) + 1;
		expect(await book.answerStatus(MOVE, { movedIn: false, landed: () => "absent" })).toEqual({ state: "receiving" });
		expect(stored()).toMatchObject(stamped);

		expect(await book.answerStatus(MOVE, { movedIn: false, landed: () => "moved_in" })).toEqual({
			state: "accepted",
		});
		const accepted = stored();
		expect(accepted).toMatchObject({ state: "accepted", target: LANDING, cwd: FOLDER });
		expect(accepted.committing).toBeUndefined();
	});
});
