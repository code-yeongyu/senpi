/**
 * senpi#6413: overlapping imports of one move into one folder. The second import looked for a landed file before the
 * first one renamed it into place, and reaches the move's record after (or while) the first commits. The move landed,
 * so the second import must answer what the files prove, the landed session, exactly as a later re-import does.
 * Answering `move_fenced` tells the sender the move did not land here; a sender that then takes the session back
 * leaves two writable copies. Every fence that is not another import's landing still refuses.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir, loadEntriesFromFileAsync } from "../../src/core/session-manager.ts";
import { finishMove } from "../../src/core/session-move/finish.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { type MoveAnswer, MoveLedger, READY_TTL_MS } from "../../src/core/session-move/move-ledger.ts";
import { type MoveId, sessionOwnership } from "../../src/core/session-move/ownership.ts";
import { customTypes, MOVE, REPO, setup } from "./session-move-fixture.ts";

type World = Awaited<ReturnType<typeof setup>>;

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Holds its commit right before the rename: the record is stamped committing and the move's lock is held. */
class HoldsCommitBeforeRename extends MoveLedger {
	readonly stamped = deferred();
	readonly gate = deferred();

	override commit<T>(
		moveId: MoveId,
		target: string,
		rename: (stampStands: () => Promise<void>) => T | Promise<T>,
		prepare?: () => void,
	): Promise<T> {
		return super.commit(
			moveId,
			target,
			async (stampStands) => {
				this.stamped.resolve();
				await this.gate.promise;
				return rename(stampStands);
			},
			prepare,
		);
	}
}

/** Says when its import asked the record to start receiving: it had looked for a landed file and found none. */
class SignalsBeginReceive extends MoveLedger {
	readonly asked = deferred();

	override beginReceive(moveId: MoveId, target: string): Promise<void> {
		const queued = super.beginReceive(moveId, target);
		this.asked.resolve();
		return queued;
	}
}

/** Waits at the door of its commit: the record is receiving, nothing is stamped and the lock is free. */
class WaitsBeforeCommit extends MoveLedger {
	readonly reached = deferred();
	readonly gate = deferred();

	override async commit<T>(
		moveId: MoveId,
		target: string,
		rename: (stampStands: () => Promise<void>) => T | Promise<T>,
		prepare?: () => void,
	): Promise<T> {
		this.reached.resolve();
		await this.gate.promise;
		return super.commit(moveId, target, rename, prepare);
	}
}

/** Its commit stamps the record and fails before the rename: nothing lands. */
class FailsBeforeRename extends MoveLedger {
	override commit<T>(
		moveId: MoveId,
		target: string,
		_rename: (stampStands: () => Promise<void>) => T | Promise<T>,
		prepare?: () => void,
	): Promise<T> {
		const failing = (): T => {
			throw new Error("the rename failed");
		};
		return super.commit(moveId, target, failing, prepare);
	}
}

const importWith = (world: World, ledger: MoveLedger) =>
	importMovedSession({ bundleDir: world.bundleDir, targetCwd: world.cwdB, ledger, readIdentity: world.readIdentity });

const settled = (pending: Promise<{ readonly sessionFile: string }>) =>
	pending.then(
		(value) => ({ value }),
		(error: unknown) => ({
			refused: typeof error === "object" && error !== null && "code" in error ? String(error.code) : String(error),
		}),
	);

const writable = async (file: string) => sessionOwnership(await loadEntriesFromFileAsync(file)).writable;

/** Where the fixture's session lands on the receiver when the import names no folder. */
const landingOf = (world: World) => join(getDefaultSessionDir(world.cwdB), basename(world.source));

/** What the second import was answered, what the receiver's record says, and what the landed file records. */
const held = async (second: ReturnType<typeof settled>, ledger: MoveLedger, landed: string) => ({
	second: await second,
	record: await ledger.answerStatus(MOVE, { movedIn: false }),
	landedEntries: customTypes(landed),
});

describe("an import that overlaps another import's commit of the same move (senpi#6413)", () => {
	it("#given a second import that looked before the first renamed #when it reaches the record while the first commits #then it answers the landed session, not move_fenced", async () => {
		const world = await setup();
		const first = new HoldsCommitBeforeRename(world.ledger.dir);
		const second = new SignalsBeginReceive(world.ledger.dir);

		const importFirst = importWith(world, first);
		await first.stamped.promise;
		const importSecond = settled(importWith(world, second));
		await second.asked.promise;
		first.gate.resolve();

		const landed = await importFirst;
		expect(await held(importSecond, world.ledger, landed.sessionFile)).toEqual({
			second: { value: { sessionFile: landed.sessionFile } },
			record: { state: "accepted" },
			landedEntries: ["session_released", "session_moved_in"],
		});
	});

	it("#given two imports both receiving #when the second commits after the first landed #then it answers the landed session, not move_fenced", async () => {
		const world = await setup();
		const first = new WaitsBeforeCommit(world.ledger.dir);
		const second = new WaitsBeforeCommit(world.ledger.dir);

		const importFirst = importWith(world, first);
		await first.reached.promise;
		const importSecond = settled(importWith(world, second));
		await second.reached.promise;
		first.gate.resolve();
		const landed = await importFirst;
		second.gate.resolve();

		expect(await held(importSecond, world.ledger, landed.sessionFile)).toEqual({
			second: { value: { sessionFile: landed.sessionFile } },
			record: { state: "accepted" },
			landedEntries: ["session_released", "session_moved_in"],
		});
	});

	it("#given the sender heard only the second import's answer #when it finishes the move on that answer #then the session is writable on one side only", async () => {
		const world = await setup();
		const first = new HoldsCommitBeforeRename(world.ledger.dir);
		const second = new SignalsBeginReceive(world.ledger.dir);
		const importFirst = importWith(world, first);
		await first.stamped.promise;
		const importSecond = settled(importWith(world, second));
		await second.asked.promise;
		first.gate.resolve();
		const landed = await importFirst;
		const heard = await importSecond;

		// What a sender does with each answer: an import that answered a session finishes accepted; a final refusal
		// (move_fenced: "the move can no longer be imported here") gives the session back as declined.
		const answer: MoveAnswer = "value" in heard ? { state: "accepted" } : { state: "declined", reason: "cancelled" };
		await finishMove({ sessionFile: world.source, bundleDir: world.bundleDir, moveId: MOVE, answer });

		expect({ heard, sender: await writable(world.source), receiver: await writable(landed.sessionFile) }).toEqual({
			heard: { value: { sessionFile: landed.sessionFile } },
			sender: false,
			receiver: true,
		});
	});
});

describe("a fence that is not another import's landing still refuses (senpi#6413)", () => {
	it.each<[string, boolean, (world: World) => MoveLedger | Promise<MoveLedger>, MoveAnswer]>([
		[
			"the receiver cancelled the move",
			true,
			async ({ ledger }) => {
				await ledger.decline(MOVE, "cancelled");
				return ledger;
			},
			{ state: "declined", reason: "cancelled" },
		],
		[
			"the receiver never readied the move",
			false,
			({ ledger }) => ledger,
			{ state: "declined", reason: "chunk_without_ready" },
		],
		[
			"the ready window passed",
			true,
			({ ledger }) => new MoveLedger(ledger.dir, { now: () => Date.now() + READY_TTL_MS + 1 }),
			{ state: "declined", reason: "expired" },
		],
		[
			"an earlier import failed",
			true,
			async ({ ledger }) => {
				await ledger.fail(MOVE, "bundle_invalid");
				return ledger;
			},
			{ state: "failed", reason: "bundle_invalid" },
		],
		[
			"the move landed in another folder",
			true,
			async (world) => {
				await importMovedSession({
					bundleDir: world.bundleDir,
					targetCwd: world.cwdB,
					ledger: world.ledger,
					readIdentity: world.readIdentity,
					sessionDir: join(world.base, "elsewhere"),
				});
				return world.ledger;
			},
			{ state: "accepted" },
		],
	])(
		"#given %s #then an import is refused move_fenced, lands nothing here and leaves the record as it was",
		async (_case, ready, arrange, record) => {
			const world = await setup(REPO, MOVE, { ready });
			const ledger = await arrange(world);

			expect(await settled(importWith(world, ledger))).toEqual({ refused: "move_fenced" });
			expect(existsSync(landingOf(world))).toBe(false);
			expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual(record);
		},
	);

	it("#given an import that stopped mid-commit without landing #when another import that was already receiving commits #then it is refused move_fenced and nothing landed", async () => {
		const world = await setup();
		const waiting = new WaitsBeforeCommit(world.ledger.dir);
		const importWaiting = settled(importWith(world, waiting));
		await waiting.reached.promise;

		await expect(importWith(world, new FailsBeforeRename(world.ledger.dir))).rejects.toThrow("the rename failed");
		waiting.gate.resolve();

		expect(await importWaiting).toEqual({ refused: "move_fenced" });
		expect(existsSync(landingOf(world))).toBe(false);
	});
});
