/**
 * The receiver's ready state (senpi#3676): a move is received only after this device said it is ready for it, a ready
 * that sees no verified bundle within its window or is cancelled is declined, and neither ever overrides a move that is
 * already receiving or accepted. The clock is injected; no test waits for real time.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import {
	type BeginReceiveOptions,
	MoveFencedError,
	MoveLedger,
	READY_TTL_MS,
} from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import { MOVE, setup } from "./session-move-fixture.ts";

/** The session file a receive in these tests lands as. */
const LANDING = "/sessions/landing.jsonl";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function clockedLedger(start = 1_000_000) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-move-ready-")));
	dirs.push(dir);
	const clock = { now: start };
	return { book: new MoveLedger(dir, { now: () => clock.now }), clock, dir };
}
const id = (value: string) => value as MoveId;

describe("MoveLedger ready state (senpi#3676)", () => {
	it("#given a ready move #when the sender asks #then it hears receiving, not a decline", async () => {
		const { book } = clockedLedger();
		expect(await book.prepare(id("r1"))).toEqual({ state: "ready", expiresAt: expect.any(String) });
		expect(await book.answerStatus(id("r1"), { movedIn: false })).toEqual({ state: "receiving" });
		await book.beginReceive(id("r1"), LANDING);
		await book.commit(id("r1"), LANDING, () => undefined);
		expect(await book.answerStatus(id("r1"), { movedIn: false })).toEqual({ state: "accepted" });
	});

	it("#given no ready record #when a bundle starts arriving #then it is refused and declined for good", async () => {
		const { book } = clockedLedger();
		await expect(book.beginReceive(id("r2"), LANDING)).rejects.toBeInstanceOf(MoveFencedError);
		expect(await book.answerStatus(id("r2"), { movedIn: false })).toEqual({
			state: "declined",
			reason: "chunk_without_ready",
		});
		await expect(book.prepare(id("r2"))).rejects.toBeInstanceOf(MoveFencedError);
	});

	it("#given a ready move whose window passed with no bundle #then it is declined as expired and never received", async () => {
		const { book, clock } = clockedLedger();
		await book.prepare(id("r3"));
		clock.now += READY_TTL_MS;
		expect(await book.answerStatus(id("r3"), { movedIn: false })).toEqual({ state: "declined", reason: "expired" });
		await expect(book.beginReceive(id("r3"), LANDING)).rejects.toBeInstanceOf(MoveFencedError);
	});

	it("#given a ready move whose window passed #when the bundle arrives first #then it is refused as expired", async () => {
		const { book, clock } = clockedLedger();
		await book.prepare(id("r4"));
		clock.now += READY_TTL_MS + 1;
		await expect(book.beginReceive(id("r4"), LANDING)).rejects.toBeInstanceOf(MoveFencedError);
		expect(await book.answerStatus(id("r4"), { movedIn: false })).toEqual({ state: "declined", reason: "expired" });
	});

	it("#given a ready move #when the sender cancels #then it is declined and a late bundle is refused", async () => {
		const { book } = clockedLedger();
		await book.prepare(id("r5"));
		expect(await book.decline(id("r5"), "cancelled")).toEqual({ state: "declined", reason: "cancelled" });
		await expect(book.beginReceive(id("r5"), LANDING)).rejects.toBeInstanceOf(MoveFencedError);
	});

	it("#given a move already receiving #when its ready window passes #then it keeps receiving", async () => {
		const { book, clock } = clockedLedger();
		await book.prepare(id("r6"));
		await book.beginReceive(id("r6"), LANDING);
		clock.now += READY_TTL_MS * 3;
		expect(await book.answerStatus(id("r6"), { movedIn: false })).toEqual({ state: "receiving" });
		expect(await book.expire(id("r6"))).toEqual({ state: "receiving" });
	});

	it("#given a ready move #when expire runs before and after the window #then only the later call declines it", async () => {
		const { book, clock } = clockedLedger();
		await book.prepare(id("r7"));
		expect(await book.expire(id("r7"))).toEqual({ state: "ready", expiresAt: expect.any(String) });
		clock.now += READY_TTL_MS;
		expect(await book.expire(id("r7"))).toEqual({ state: "declined", reason: "expired" });
	});

	it("#given a ready move #when ready is sent again #then the first window stands and a receiving move stays receiving", async () => {
		const { book, clock } = clockedLedger();
		const first = await book.prepare(id("r8"));
		clock.now += 1000;
		expect(await book.prepare(id("r8"))).toEqual(first);
		await book.beginReceive(id("r8"), LANDING);
		expect(await book.prepare(id("r8"))).toEqual({ state: "receiving" });
	});

	it("#given a ready move whose window passed #when it is cancelled or failed #then it reports expired and the answer never changes", async () => {
		const { book, clock } = clockedLedger();
		await book.prepare(id("r10"));
		await book.prepare(id("r11"));
		clock.now += READY_TTL_MS;
		const expired = { state: "declined", reason: "expired" };

		expect(await book.decline(id("r10"), "cancelled")).toEqual(expired);
		expect(await book.fail(id("r11"), "bundle_invalid")).toEqual(expired);

		for (const move of [id("r10"), id("r11")]) {
			expect(await book.answerStatus(move, { movedIn: false })).toEqual(expired);
			expect(await book.fail(move, "import_failed")).toEqual(expired);
			expect(await book.decline(move, "repository")).toEqual(expired);
			expect(await book.answerStatus(move, { movedIn: false })).toEqual(expired);
		}
	});

	it("#given a move already answered declined or failed #then a later decline or fail never changes the answer", async () => {
		const { book } = clockedLedger();
		const noRecord = { state: "declined", reason: "no_record" };
		expect(await book.answerStatus(id("r12"), { movedIn: false })).toEqual(noRecord);
		expect(await book.fail(id("r12"), "bundle_invalid")).toEqual(noRecord);
		expect(await book.decline(id("r12"), "repository")).toEqual(noRecord);
		expect(await book.answerStatus(id("r12"), { movedIn: false })).toEqual(noRecord);

		await book.prepare(id("r13"));
		await book.beginReceive(id("r13"), LANDING);
		const failed = { state: "failed", reason: "import_failed" };
		expect(await book.fail(id("r13"), "import_failed")).toEqual(failed);
		expect(await book.decline(id("r13"), "cancelled")).toEqual(failed);
		expect(await book.fail(id("r13"), "bundle_invalid")).toEqual(failed);
		expect(await book.answerStatus(id("r13"), { movedIn: false })).toEqual(failed);
	});

	it("#given a ready move #when the device restarts #then the ready record and its window survive on disk", async () => {
		const { book, clock, dir } = clockedLedger();
		await book.prepare(id("r9"));
		const reopened = new MoveLedger(dir, { now: () => clock.now });
		expect(await reopened.answerStatus(id("r9"), { movedIn: false })).toEqual({ state: "receiving" });
		clock.now += READY_TTL_MS;
		expect(await reopened.answerStatus(id("r9"), { movedIn: false })).toEqual({
			state: "declined",
			reason: "expired",
		});
	});
});

// senpi#6435
describe("MoveLedger keeps the folder a move was readied for (senpi#6435)", () => {
	const stored = (dir: string, move: string) =>
		JSON.parse(readFileSync(join(dir, `${move}.json`), "utf8")) as Record<string, unknown>;

	it("#given a move readied for a folder #when ready is sent again #then the same folder and a ready with no folder keep the first window, and another folder is refused", async () => {
		const { book, clock } = clockedLedger();
		const first = await book.prepare(id("f1"), "/work/one");
		expect(first).toEqual({ state: "ready", expiresAt: expect.any(String) });
		clock.now += 1000;

		expect(await book.prepare(id("f1"), "/work/one")).toEqual(first);
		expect(await book.prepare(id("f1"))).toEqual(first);
		await expect(book.prepare(id("f1"), "/work/two")).rejects.toBeInstanceOf(MoveFencedError);
		expect(await book.expire(id("f1"))).toEqual(first);
	});

	it("#given a move readied for a folder #when a receive begins for another folder or names none #then it is refused, the move stays ready, and a receive for that folder begins", async () => {
		const { book } = clockedLedger();
		const first = await book.prepare(id("f2"), "/work/one");

		await expect(book.beginReceive(id("f2"), LANDING, { cwd: "/work/two" })).rejects.toBeInstanceOf(MoveFencedError);
		await expect(book.beginReceive(id("f2"), LANDING)).rejects.toBeInstanceOf(MoveFencedError);
		expect(await book.expire(id("f2"))).toEqual(first);

		await book.beginReceive(id("f2"), LANDING, { cwd: "/work/one" });
		expect(await book.answerStatus(id("f2"), { movedIn: false })).toEqual({ state: "receiving" });
	});

	it("#given a move readied with no folder #when a later ready names one #then the first window stands and the move is held to that folder", async () => {
		const { book, clock } = clockedLedger();
		const first = await book.prepare(id("f3"));
		clock.now += 1000;

		expect(await book.prepare(id("f3"), "/work/one")).toEqual(first);

		await expect(book.beginReceive(id("f3"), LANDING, { cwd: "/work/two" })).rejects.toBeInstanceOf(MoveFencedError);
		await book.beginReceive(id("f3"), LANDING, { cwd: "/work/one" });
	});

	// The record on disk is a storage contract: every writer of a move's record keeps the folder in the field `cwd`.
	it.each([
		["readied for that folder", "/work/one"],
		["readied with no folder", undefined],
	])(
		"#given a move %s #when its receive names the folder #then the ready record and every record from receiving to accepted hold it as cwd",
		async (name, readiedFor) => {
			const { book, dir } = clockedLedger();
			const move = `f4-${name.length}`;
			await book.prepare(id(move), readiedFor);
			expect(stored(dir, move).cwd).toBe(readiedFor);

			await book.beginReceive(id(move), LANDING, { cwd: "/work/one" });
			expect(stored(dir, move)).toMatchObject({ state: "receiving", target: LANDING, cwd: "/work/one" });
			let stamped: Record<string, unknown> = {};
			await book.commit(id(move), LANDING, () => {
				stamped = stored(dir, move);
			});

			expect(stamped).toMatchObject({ state: "receiving", committing: true, target: LANDING, cwd: "/work/one" });
			expect(stored(dir, move)).toMatchObject({ state: "accepted", target: LANDING, cwd: "/work/one" });
		},
	);
});

describe("importMovedSession needs a ready move (senpi#3676)", () => {
	it("#given a bundle for a move this device never readied #then the import is refused and nothing is staged", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup(undefined, undefined, { ready: false });
		await expect(importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity })).rejects.toBeInstanceOf(
			MoveFencedError,
		);
		expect(existsSync(join(getDefaultSessionDir(cwdB), ".move-staging"))).toBe(false);
		expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({
			state: "declined",
			reason: "chunk_without_ready",
		});
	});

	it("#given a readied move #then the import commits", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		const { sessionFile } = await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		expect(existsSync(sessionFile)).toBe(true);
		expect(await ledger.answerStatus(MOVE, { movedIn: true })).toEqual({ state: "accepted" });
	});
});

const signal = () => {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

/** Holds its commit between the stamp and the rename, so the move's record lock is held until `gate` opens. */
class HoldsCommit extends MoveLedger {
	readonly stamped = signal();
	readonly gate = signal();

	override commit<T>(
		moveId: MoveId,
		target: string,
		rename: (stampStands: () => Promise<void>) => T | Promise<T>,
		prepare?: () => void,
	): Promise<T> {
		const held = async (stampStands: () => Promise<void>) => {
			this.stamped.resolve();
			await this.gate.promise;
			return rename(stampStands);
		};
		return super.commit(moveId, target, held, prepare);
	}
}

/** Says when its import reached `beginReceive`, which is after the folder fence and the repository check. */
class SignalsReceive extends MoveLedger {
	readonly reached = signal();

	override beginReceive(moveId: MoveId, target: string, options?: BeginReceiveOptions): Promise<void> {
		this.reached.resolve();
		return super.beginReceive(moveId, target, options);
	}
}

/** A bounded wait: the fence must be passed while the other import still holds the lock, not after it lets go. */
async function within(promise: Promise<void>, ms: number, failure: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(failure)), ms);
	});
	try {
		await Promise.race([promise, late]);
	} finally {
		clearTimeout(timer);
	}
}

// senpi#6435 with senpi#6413: the import's folder fence takes no lock. An import that arrives while another import of
// the same move holds the record lock gets past the fence at once and waits only at `beginReceive`, where it is fenced
// and answers the file the other import landed.
describe("the import's folder fence does not wait for another import's lock (senpi#6435)", () => {
	it("#given one import holding the move's lock between its stamp and its rename #when a second import of the move arrives #then it passes the folder fence while that lock is held and answers the landed session", async () => {
		const world = await setup();
		const first = new HoldsCommit(world.ledger.dir);
		const second = new SignalsReceive(world.ledger.dir);
		const importInto = (ledger: MoveLedger) =>
			importMovedSession({
				bundleDir: world.bundleDir,
				targetCwd: world.cwdB,
				ledger,
				readIdentity: world.readIdentity,
			});
		const firstImport = importInto(first);
		await first.stamped.promise;
		const secondImport = importInto(second);

		await within(
			second.reached.promise,
			5_000,
			"the second import never reached beginReceive while the first held the move's lock: the folder fence waited for it",
		);
		first.gate.resolve();
		const [landed, answered] = await Promise.all([firstImport, secondImport]);

		expect(answered.sessionFile).toBe(landed.sessionFile);
		expect(await world.ledger.answerStatus(MOVE, { movedIn: true })).toEqual({ state: "accepted" });
	});
});
