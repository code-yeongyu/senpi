import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MoveFencedError, MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import { MoveRecordUnlockedError } from "../../src/core/session-move/move-ledger-lock.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";

/** The session file a receive in these tests lands as. */
const LANDING = "/sessions/landing.jsonl";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function ledger(): MoveLedger {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-move-ledger-")));
	dirs.push(dir);
	return new MoveLedger(dir);
}
const id = (value: string) => value as MoveId;

describe("MoveLedger fence", () => {
	it("#given an accepted move, revoked or not #then no receive or commit lands it again, at any target", async () => {
		const book = ledger();
		for (const [move, revoke] of [
			[id("a1"), false],
			[id("a2"), true],
		] as const) {
			await book.prepare(move);
			await book.beginReceive(move, LANDING);
			await book.commit(move, LANDING, () => undefined);
			if (revoke) await book.markRevoked(move);
			await expect(book.beginReceive(move, "/sessions/elsewhere.jsonl")).rejects.toBeInstanceOf(MoveFencedError);
			await expect(book.commit(move, "/sessions/elsewhere.jsonl", () => undefined)).rejects.toBeInstanceOf(
				MoveFencedError,
			);
			await expect(book.beginReceive(move, LANDING)).rejects.toBeInstanceOf(MoveFencedError);
			await expect(book.commit(move, LANDING, () => undefined)).rejects.toBeInstanceOf(MoveFencedError);
		}
	});

	it("#given a receive in progress #then a receive or commit for another target is fenced and the first target wins", async () => {
		const book = ledger();
		await book.prepare(id("t1"));
		await book.beginReceive(id("t1"), LANDING);
		await expect(book.beginReceive(id("t1"), "/sessions/elsewhere.jsonl")).rejects.toBeInstanceOf(MoveFencedError);
		await expect(book.commit(id("t1"), "/sessions/elsewhere.jsonl", () => undefined)).rejects.toBeInstanceOf(
			MoveFencedError,
		);
		await book.commit(id("t1"), LANDING, () => undefined);
		expect(await book.answerStatus(id("t1"), { movedIn: false })).toEqual({ state: "accepted" });
	});

	it("#given a receiving record with no landing target (an older build) #then a receive for any target is fenced", async () => {
		const book = ledger();
		writeFileSync(join(book.dir, "t2.json"), `${JSON.stringify({ state: "receiving" })}\n`);
		await expect(book.beginReceive(id("t2"), LANDING)).rejects.toBeInstanceOf(MoveFencedError);
		await expect(book.commit(id("t2"), LANDING, () => undefined)).rejects.toBeInstanceOf(MoveFencedError);
	});

	it("#given a revoke whose record was lost or reset to plain accepted #when the revoke repeats #then revoked: true is back", async () => {
		const book = ledger();
		await book.prepare(id("v1"));
		await book.beginReceive(id("v1"), LANDING);
		await book.commit(id("v1"), LANDING, () => undefined);
		await book.markRevoked(id("v1"));
		const record = join(book.dir, "v1.json");

		rmSync(record);
		await book.markRevoked(id("v1"));
		expect(await book.answerStatus(id("v1"), { movedIn: false })).toEqual({ state: "accepted", revoked: true });

		writeFileSync(record, `${JSON.stringify({ state: "accepted" })}\n`);
		expect(await book.answerStatus(id("v1"), { movedIn: false })).toEqual({ state: "accepted" });
		await book.markRevoked(id("v1"));
		expect(await book.answerStatus(id("v1"), { movedIn: false })).toEqual({ state: "accepted", revoked: true });
	});

	it("#given no record #when the sender asks #then the answer is a durable decline that blocks a later import", async () => {
		const book = ledger();
		expect(await book.answerStatus(id("m1"), { movedIn: false })).toEqual({ state: "declined", reason: "no_record" });
		await expect(book.beginReceive(id("m1"), LANDING)).rejects.toBeInstanceOf(MoveFencedError);
		await expect(book.commit(id("m1"), LANDING, () => undefined)).rejects.toBeInstanceOf(MoveFencedError);
	});

	it("#given a receive in progress #when the sender asks #then it hears receiving and nothing is declined", async () => {
		const book = ledger();
		await book.prepare(id("m2"));
		await book.beginReceive(id("m2"), LANDING);
		expect(await book.answerStatus(id("m2"), { movedIn: false })).toEqual({ state: "receiving" });
		await book.commit(id("m2"), LANDING, () => undefined);
		expect(await book.answerStatus(id("m2"), { movedIn: false })).toEqual({ state: "accepted" });
	});

	it("#given an accepted move whose session was later deleted #when the sender asks #then it still hears accepted", async () => {
		const book = ledger();
		await book.prepare(id("m3"));
		await book.beginReceive(id("m3"), LANDING);
		await book.commit(id("m3"), LANDING, () => undefined);
		expect(await book.answerStatus(id("m3"), { movedIn: false })).toEqual({ state: "accepted" });
	});

	it("#given an accepted move #when a cancel or expiry arrives #then it never turns into a decline", async () => {
		const book = ledger();
		await book.prepare(id("m4"));
		await book.beginReceive(id("m4"), LANDING);
		await book.commit(id("m4"), LANDING, () => undefined);
		expect(await book.decline(id("m4"), "cancelled")).toEqual({ state: "accepted" });
	});

	it("#given a commit whose rename throws #then nothing is recorded as accepted", async () => {
		const book = ledger();
		await book.prepare(id("m5"));
		await book.beginReceive(id("m5"), LANDING);
		await expect(
			book.commit(id("m5"), LANDING, () => {
				throw new Error("disk full");
			}),
		).rejects.toThrow("disk full");
		expect(await book.answerStatus(id("m5"), { movedIn: false })).toEqual({ state: "receiving" });
	});

	it("#given a record write outside the move's lock #then it fails loudly and leaves the record unwritten", async () => {
		const book = ledger();
		await book.prepare(id("m6"));
		const write: unknown = Reflect.get(book, "write");
		if (typeof write !== "function") throw new Error("MoveLedger.write is gone; update this test");
		await expect(Reflect.apply(write, book, [id("m6"), { state: "accepted" }])).rejects.toBeInstanceOf(
			MoveRecordUnlockedError,
		);
		expect(await book.answerStatus(id("m6"), { movedIn: false })).not.toEqual({ state: "accepted" });
	});
});
