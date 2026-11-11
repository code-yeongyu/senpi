/**
 * senpi#6417: a commit holds its move record's lock from its stamp to its rename, but a holder that stalls past the
 * lock's stale bound loses it. Whoever takes the lock then reads a commit stamp with no landed file. Settling that as
 * failed while the stalled holder can still rename tells the sender to take the session back, and the holder then
 * lands a second writable copy.
 */
import { existsSync, symlinkSync, utimesSync } from "node:fs";
import { basename, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultSessionDir, loadEntriesFromFileAsync } from "../../src/core/session-manager.ts";
import { finishMove } from "../../src/core/session-move/finish.ts";
import { answerMoveStatus, importMovedSession } from "../../src/core/session-move/import.ts";
import { MoveLedger, type MoveLedgerOptions } from "../../src/core/session-move/move-ledger.ts";
import { setMoveStepHook } from "../../src/core/session-move/move-steps.ts";
import { type MoveId, sessionOwnership } from "../../src/core/session-move/ownership.ts";
import { MOVE, setup } from "./session-move-fixture.ts";

type World = Awaited<ReturnType<typeof setup>>;

const realLock = lockfile.lock;
const AN_HOUR_MS = 60 * 60_000;

afterEach(() => {
	vi.restoreAllMocks();
	setMoveStepHook(undefined);
});

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

	override commit<T>(moveId: MoveId, target: string, rename: () => T | Promise<T>, prepare?: () => void): Promise<T> {
		return super.commit(
			moveId,
			target,
			async () => {
				this.stamped.resolve();
				await this.gate.promise;
				return rename();
			},
			prepare,
		);
	}
}

const recordOf = (world: World) => join(world.ledger.dir, `${MOVE}.json`);

/**
 * The holder of this record's lock is stalled: it never refreshes the lock, and a refresh is also how a holder learns
 * its lock is gone. `taken()` stands for that refresh finding the lock taken: the lock is gone and the holder is told.
 */
function stallHolderOf(record: string): { readonly taken: () => void } {
	let taken = () => {};
	vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
		if (file !== record) return realLock(file, options);
		const release = await realLock(file, { ...options, stale: 2 * AN_HOUR_MS, update: AN_HOUR_MS });
		taken = () => {
			void release().catch(() => undefined);
			options?.onCompromised?.(Object.assign(new Error("the lock was taken"), { code: "ECOMPROMISED" }));
		};
		return release;
	});
	return { taken: () => taken() };
}

/**
 * Another process has its own queue, so only the lock file stands between it and the holder. This ledger reaches the
 * same records by another path, which keeps this process's queue from serializing the two.
 */
function ledgerOfAnotherProcess(world: World, options?: MoveLedgerOptions): MoveLedger {
	const link = join(world.base, "ledger-by-another-path");
	if (!existsSync(link)) symlinkSync(world.ledger.dir, link);
	return new MoveLedger(link, options);
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

describe("a commit whose holder lost the move record's lock (senpi#6417)", () => {
	it("#given a holder stalled between its stamp and its rename, past the lock's stale bound #when another process asks status #then it hears receiving, the move lands once and the sender's copy stays sealed", async () => {
		const world = await setup();
		stallHolderOf(recordOf(world));
		const holder = new HoldsCommitBeforeRename(world.ledger.dir);
		const importing = importWith(world, holder);
		await holder.stamped.promise;
		const longAgo = new Date(Date.now() - AN_HOUR_MS);
		utimesSync(`${recordOf(world)}.lock`, longAgo, longAgo);

		const heard = await answerMoveStatus(ledgerOfAnotherProcess(world), MOVE, undefined);
		holder.gate.resolve();
		const landed = await importing;
		await finishMove({ sessionFile: world.source, bundleDir: world.bundleDir, moveId: MOVE, answer: heard });

		expect({
			heard,
			record: await answerMoveStatus(world.ledger, MOVE, undefined),
			sender: await writable(world.source),
			receiver: await writable(landed.sessionFile),
		}).toEqual({ heard: { state: "receiving" }, record: { state: "accepted" }, sender: false, receiver: true });
	});

	it("#given a holder told right after its stamp that its lock was taken #then it renames nothing and its import fails", async () => {
		const world = await setup();
		const lock = stallHolderOf(recordOf(world));
		setMoveStepHook((step) => {
			if (step === "import:stamped") lock.taken();
		});

		const answer = await settled(importWith(world, world.ledger));

		expect({ answer, landed: existsSync(landingOf(world)) }).toEqual({
			answer: { refused: "ELOCKLOST" },
			landed: false,
		});
	});

	it("#given a commit that died after its stamp #then status answers receiving while the stamp is young and failed once it is old", async () => {
		const world = await setup();
		setMoveStepHook((step) => {
			if (step === "import:stamped") throw new Error("the process died");
		});
		await expect(importWith(world, world.ledger)).rejects.toThrow("the process died");
		setMoveStepHook(undefined);

		const young = await answerMoveStatus(world.ledger, MOVE, undefined);
		const anHourLater = ledgerOfAnotherProcess(world, { now: () => Date.now() + AN_HOUR_MS });

		expect({
			young,
			old: await answerMoveStatus(anHourLater, MOVE, undefined),
			landed: existsSync(landingOf(world)),
		}).toEqual({ young: { state: "receiving" }, old: { state: "failed", reason: "import_failed" }, landed: false });
	});
});
