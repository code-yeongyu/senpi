/**
 * senpi#6435 with senpi#6417: the commit stamp of a move that was readied for a folder. The commit that re-checks its
 * lock writes the stamp, and the rule that leaves a young stamp unsettled reads it back and later settles it. Both
 * must keep the folder: the record on disk is a storage contract, and every writer of it keeps the field `cwd`.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMMIT_SETTLE_AFTER_MS } from "../../src/core/session-move/move-landing.ts";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";

const LANDING = "/sessions/landing.jsonl";
const FOLDER = "/work/one";
const MOVE = "stamp-1" as MoveId;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A move whose commit wrote its stamp and stopped at the rename: the stamp is on disk and no file landed. */
async function stampedMove(readiedFor: string | undefined) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-move-stamp-")));
	dirs.push(dir);
	const clock = { now: 1_000_000 };
	const book = new MoveLedger(dir, { now: () => clock.now });
	const stored = () => JSON.parse(readFileSync(join(dir, `${MOVE}.json`), "utf8")) as Record<string, unknown>;
	await book.prepare(MOVE, readiedFor);
	await book.beginReceive(MOVE, LANDING, { cwd: readiedFor });
	const stopping = () => {
		throw new Error("the rename stopped");
	};
	await expect(book.commit(MOVE, LANDING, stopping)).rejects.toThrow("the rename stopped");
	// The stamp carries the time it was written; the ledger's clock is set from it, so no real time passes here.
	return { book, clock, stored, stampedAt: Date.parse(String(stored().at)) };
}

describe("a commit stamp keeps the folder its move was readied for (senpi#6435, senpi#6417)", () => {
	it("#given a move readied for a folder whose commit stamped it and stopped at the rename #when the sender asks while no file is there, right after the stamp, and again once the file is there #then the stamp holds the folder and is not failed while young, and the accepted record still holds the folder", async () => {
		const { book, clock, stored, stampedAt } = await stampedMove(FOLDER);
		const stamped = { state: "receiving", committing: true, target: LANDING, cwd: FOLDER };
		expect(stored()).toMatchObject(stamped);

		clock.now = stampedAt + 1;
		expect(await book.answerStatus(MOVE, { movedIn: false, landed: () => "absent" })).toEqual({ state: "receiving" });
		expect(stored()).toMatchObject(stamped);

		expect(await book.answerStatus(MOVE, { movedIn: false, landed: () => "moved_in" })).toEqual({
			state: "accepted",
		});
		const accepted = stored();
		expect(accepted).toMatchObject({ state: "accepted", target: LANDING, cwd: FOLDER });
		expect(accepted.committing).toBeUndefined();
	});

	it("#given a commit stamp with no folder, older than the settle bound #when a prepare names a folder #then the stamp is left exactly as it was written, and the move is settled failed as it would have been", async () => {
		const { book, clock, stored, stampedAt } = await stampedMove(undefined);
		const stamp = stored();
		clock.now = stampedAt + COMMIT_SETTLE_AFTER_MS;

		expect(await book.prepare(MOVE, FOLDER)).toEqual({ state: "receiving" });
		expect(stored()).toEqual(stamp);

		expect(await book.answerStatus(MOVE, { movedIn: false, landed: () => "absent" })).toEqual({
			state: "failed",
			reason: "import_failed",
		});
	});
});
