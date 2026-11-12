/**
 * senpi#6417: a commit holds its move record's lock from its stamp to its rename, but a holder that stalls past the
 * lock's stale bound loses it. Whoever takes the lock then reads a commit stamp with no landed file. Settling that as
 * failed while the stalled holder can still rename tells the sender to take the session back, and the holder then
 * lands a second writable copy.
 */
import { existsSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { basename, dirname, join } from "node:path";
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

const afterRename = vi.hoisted(() => new Map<string, () => Promise<void>>());

// A rename is durable once it returns. A test holds a caller right after one, where a stalled process would be held.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rename: async (...args: Parameters<typeof actual.rename>) => {
			await actual.rename(...args);
			await afterRename.get(String(args[1]))?.();
		},
	};
});

const realLock = lockfile.lock;
const AN_HOUR_MS = 60 * 60_000;

/** A process for which an hour really passed: its wall clock and the machine's uptime both read an hour later. */
const AN_HOUR_LATER: MoveLedgerOptions = {
	now: () => Date.now() + AN_HOUR_MS,
	uptime: () => uptime() * 1000 + AN_HOUR_MS,
};

afterEach(() => {
	vi.restoreAllMocks();
	setMoveStepHook(undefined);
	afterRename.clear();
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

/** Holds its commit at the end of `prepare`: nothing is stamped yet and the move's lock is held. */
class HoldsCommitInPrepare extends MoveLedger {
	readonly preparing = deferred();
	readonly gate = deferred();

	override commit<T>(
		moveId: MoveId,
		target: string,
		rename: (stampStands: () => Promise<void>) => T | Promise<T>,
		prepare?: () => void | Promise<void>,
	): Promise<T> {
		return super.commit(moveId, target, rename, async () => {
			await prepare?.();
			this.preparing.resolve();
			await this.gate.promise;
		});
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

/** Holds whoever writes this record's commit stamp right after the stamp is on disk, until `resume()`. */
function stallAfterStamp(record: string): { readonly reached: Promise<void>; readonly resume: () => void } {
	const reached = deferred();
	const gate = deferred();
	afterRename.set(record, async () => {
		if (!readFileSync(record, "utf8").includes('"committing":true')) return;
		reached.resolve();
		await gate.promise;
	});
	return { reached: reached.promise, resume: gate.resolve };
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

	it("#given a holder stalled right after its stamp, past the settle bound, and another process that settled the move failed #when the holder runs again #then it lands nothing and one copy is writable", async () => {
		const world = await setup();
		stallHolderOf(recordOf(world));
		const stall = stallAfterStamp(recordOf(world));
		const importing = settled(importWith(world, world.ledger));
		await stall.reached;
		const longAgo = new Date(Date.now() - AN_HOUR_MS);
		utimesSync(`${recordOf(world)}.lock`, longAgo, longAgo);
		const anHourLater = ledgerOfAnotherProcess(world, AN_HOUR_LATER);

		const heard = await answerMoveStatus(anHourLater, MOVE, undefined);
		await finishMove({ sessionFile: world.source, bundleDir: world.bundleDir, moveId: MOVE, answer: heard });
		stall.resume();

		expect({
			heard,
			holder: await importing,
			landed: existsSync(landingOf(world)),
			sender: await writable(world.source),
		}).toEqual({
			heard: { state: "failed", reason: "import_failed" },
			holder: { refused: "move_fenced" },
			landed: false,
			sender: true,
		});
	});

	it("#given a holder stalled inside its commit's prepare, past the lock's stale bound, and another process whose import of the move failed #when the holder runs again #then it stamps nothing, lands nothing and one copy is writable", async () => {
		const world = await setup();
		stallHolderOf(recordOf(world));
		const holder = new HoldsCommitInPrepare(world.ledger.dir);
		const importing = settled(importWith(world, holder));
		await holder.preparing.promise;
		const longAgo = new Date(Date.now() - AN_HOUR_MS);
		utimesSync(`${recordOf(world)}.lock`, longAgo, longAgo);
		const another = ledgerOfAnotherProcess(world);

		await another.fail(MOVE, "import_failed");
		const heard = await answerMoveStatus(another, MOVE, undefined);
		await finishMove({ sessionFile: world.source, bundleDir: world.bundleDir, moveId: MOVE, answer: heard });
		holder.gate.resolve();

		expect({
			heard,
			holder: await importing,
			landed: existsSync(landingOf(world)),
			record: await answerMoveStatus(another, MOVE, undefined),
			sender: await writable(world.source),
		}).toEqual({
			heard: { state: "failed", reason: "import_failed" },
			holder: { refused: "move_fenced" },
			landed: false,
			record: { state: "failed", reason: "import_failed" },
			sender: true,
		});
	});

	it.each([
		["an hour old", AN_HOUR_MS],
		["an hour old on a machine whose wall clock was stepped back an hour", -AN_HOUR_MS],
	])(
		"#given a commit that died after its stamp #then status answers receiving while the stamp is young and failed once it is %s",
		async (_age, clockOffsetMs) => {
			const world = await setup();
			setMoveStepHook((step) => {
				if (step === "import:stamped") throw new Error("the process died");
			});
			await expect(importWith(world, world.ledger)).rejects.toThrow("the process died");
			setMoveStepHook(undefined);

			const young = await answerMoveStatus(world.ledger, MOVE, undefined);
			const later = ledgerOfAnotherProcess(world, { ...AN_HOUR_LATER, now: () => Date.now() + clockOffsetMs });

			expect({
				young,
				later: await answerMoveStatus(later, MOVE, undefined),
				landed: existsSync(landingOf(world)),
			}).toEqual({
				young: { state: "receiving" },
				later: { state: "failed", reason: "import_failed" },
				landed: false,
			});
		},
	);

	it("#given a holder between its stamp and its rename #when a process on the same machine whose wall clock was stepped an hour ahead asks status #then it hears receiving, the move lands once and the sender's copy stays sealed", async () => {
		const world = await setup();
		stallHolderOf(recordOf(world));
		const holder = new HoldsCommitBeforeRename(world.ledger.dir);
		const importing = importWith(world, holder);
		await holder.stamped.promise;
		// A forward step is also what makes the lock library call a held lock stale and hand it over.
		const longAgo = new Date(Date.now() - AN_HOUR_MS);
		utimesSync(`${recordOf(world)}.lock`, longAgo, longAgo);
		const steppedAhead = ledgerOfAnotherProcess(world, { now: () => Date.now() + AN_HOUR_MS });

		const heard = await answerMoveStatus(steppedAhead, MOVE, undefined);
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

	it.each([
		["an hour ahead", AN_HOUR_MS],
		["an hour back", -AN_HOUR_MS],
	])(
		"#given a commit that died after its stamp #when a process on the same machine whose wall clock was stepped %s asks status right away #then it hears receiving: a step does not age the stamp",
		async (_step, wallOffsetMs) => {
			const world = await setup();
			setMoveStepHook((step) => {
				if (step === "import:stamped") throw new Error("the process died");
			});
			await expect(importWith(world, world.ledger)).rejects.toThrow("the process died");
			setMoveStepHook(undefined);
			const stepped = ledgerOfAnotherProcess(world, { now: () => Date.now() + wallOffsetMs });

			expect(await answerMoveStatus(stepped, MOVE, undefined)).toEqual({ state: "receiving" });
		},
	);

	it.each([
		["another machine", { host: "another-machine" }],
		["this machine after a restart", { uptime: () => 1_000 }],
	])(
		"#given a commit that died after its stamp #when %s reads it with a wall clock an hour later #then the wall clock decides and it hears failed",
		async (_reader, reader) => {
			const world = await setup();
			setMoveStepHook((step) => {
				if (step === "import:stamped") throw new Error("the process died");
			});
			await expect(importWith(world, world.ledger)).rejects.toThrow("the process died");
			setMoveStepHook(undefined);
			const later = ledgerOfAnotherProcess(world, { now: () => Date.now() + AN_HOUR_MS, ...reader });

			expect(await answerMoveStatus(later, MOVE, undefined)).toEqual({ state: "failed", reason: "import_failed" });
		},
	);

	it("#given a holder stalled after its stamp check and before its file lands, past the settle bound, and another process that settled the move failed #when the holder runs again #then it lands nothing, leaves no rewritten copy and one copy is writable", async () => {
		const world = await setup();
		stallHolderOf(recordOf(world));
		const holder = new HoldsCommitBeforeRename(world.ledger.dir);
		const importing = settled(importWith(world, holder));
		await holder.stamped.promise;
		const longAgo = new Date(Date.now() - AN_HOUR_MS);
		utimesSync(`${recordOf(world)}.lock`, longAgo, longAgo);

		const heard = await answerMoveStatus(ledgerOfAnotherProcess(world, AN_HOUR_LATER), MOVE, undefined);
		await finishMove({ sessionFile: world.source, bundleDir: world.bundleDir, moveId: MOVE, answer: heard });
		holder.gate.resolve();

		expect({
			heard,
			holder: await importing,
			landed: existsSync(landingOf(world)),
			rewrittenCopies: readdirSync(dirname(landingOf(world))).filter((name) => name.includes(".rebind-")),
			sender: await writable(world.source),
		}).toEqual({
			heard: { state: "failed", reason: "import_failed" },
			holder: { refused: "move_fenced" },
			landed: false,
			rewrittenCopies: [],
			sender: true,
		});
	});

	// The lock can be lost while the landing waits (for the session's move lock, or rewriting the copy): the stamp check
	// the landing runs right before its rename asserts the lock again.
	it("#given a holder told after its stamp check, before its file lands, that its lock was taken #then it lands nothing, leaves no rewritten copy and its import fails", async () => {
		const world = await setup();
		const lock = stallHolderOf(recordOf(world));
		const holder = new HoldsCommitBeforeRename(world.ledger.dir);
		const importing = settled(importWith(world, holder));
		await holder.stamped.promise;

		lock.taken();
		holder.gate.resolve();

		expect({
			answer: await importing,
			landed: existsSync(landingOf(world)),
			rewrittenCopies: readdirSync(dirname(landingOf(world))).filter((name) => name.includes(".rebind-")),
		}).toEqual({ answer: { refused: "ELOCKLOST" }, landed: false, rewrittenCopies: [] });
	});

	it("#given a holder told during its commit's prepare that its lock was taken #then it stamps nothing, lands nothing and its import fails", async () => {
		const world = await setup();
		const lock = stallHolderOf(recordOf(world));
		const holder = new HoldsCommitInPrepare(world.ledger.dir);
		const importing = settled(importWith(world, holder));
		await holder.preparing.promise;

		lock.taken();
		holder.gate.resolve();

		expect({
			answer: await importing,
			stamped: readFileSync(recordOf(world), "utf8").includes('"committing":true'),
			landed: existsSync(landingOf(world)),
		}).toEqual({ answer: { refused: "ELOCKLOST" }, stamped: false, landed: false });
	});

	it.each([
		["a newer", AN_HOUR_MS],
		["an older", -AN_HOUR_MS],
	])(
		"#given a holder past its own stamp and %s commit stamp of the same move in the record, as another import's commit that took its record over leaves it #when the holder goes to land its file #then it lands nothing and is refused, and the record keeps the other stamp",
		async (_which, offsetMs) => {
			const world = await setup();
			const holder = new HoldsCommitBeforeRename(world.ledger.dir);
			const importing = settled(importWith(world, holder));
			await holder.stamped.promise;
			const mine: unknown = JSON.parse(readFileSync(recordOf(world), "utf8"));
			if (typeof mine !== "object" || mine === null || !("at" in mine) || typeof mine.at !== "string")
				throw new Error("the holder left no commit stamp");
			// The same move, stamped committing at another time: only the time tells the two stamps apart.
			const other = { ...mine, at: new Date(Date.parse(mine.at) + offsetMs).toISOString() };
			writeFileSync(recordOf(world), `${JSON.stringify(other)}\n`);

			holder.gate.resolve();

			expect({
				holder: await importing,
				landed: existsSync(landingOf(world)),
				record: JSON.parse(readFileSync(recordOf(world), "utf8")),
			}).toEqual({ holder: { refused: "move_fenced" }, landed: false, record: other });
		},
	);
});
