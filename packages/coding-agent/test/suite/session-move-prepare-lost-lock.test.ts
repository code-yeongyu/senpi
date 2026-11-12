/**
 * senpi#6492: what a commit's `prepare` removes and copies is written under the move record's lock. A holder that was
 * told its lock is gone before that step must stop there: whoever took the lock may have settled the move, and a
 * removal made after that takes away files the holder no longer has a claim on.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { exportSessionForMove } from "../../src/core/session-move/export.ts";
import { movedStateDir } from "../../src/core/session-move/extension-state.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import { MOVE, SESSION_ID, setup, writeSession } from "./session-move-fixture.ts";

const realLock = lockfile.lock;

afterEach(() => {
	vi.restoreAllMocks();
});

/** `taken()` stands for the holder's lock refresh finding this record's lock taken: the lock is gone and it is told. */
function holderOf(record: string): { readonly taken: () => void } {
	let taken = () => {};
	vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
		const release = await realLock(file, options);
		if (file === record)
			taken = () => {
				void release().catch(() => undefined);
				options?.onCompromised?.(Object.assign(new Error("the lock was taken"), { code: "ECOMPROMISED" }));
			};
		return release;
	});
	return { taken: () => taken() };
}

/** Learns its lock is gone as its commit's `prepare` begins: nothing is removed, copied or stamped yet. */
class LosesLockBeforePrepare extends MoveLedger {
	lose = () => {};

	override commit<T>(
		moveId: MoveId,
		target: string,
		rename: () => T | Promise<T>,
		prepare?: () => void | Promise<void>,
	): Promise<T> {
		return super.commit(moveId, target, rename, async () => {
			this.lose();
			await prepare?.();
		});
	}
}

const codeOf = (error: unknown) =>
	typeof error === "object" && error !== null && "code" in error ? String(error.code) : String(error);

type World = Awaited<ReturnType<typeof setup>>;

/** Imports `bundleDir` with a holder that is told its lock was taken as its commit's `prepare` begins. */
function importLosingLock(world: World, moveId: MoveId, bundleDir: string): Promise<string> {
	const holder = new LosesLockBeforePrepare(world.ledger.dir);
	holder.lose = holderOf(join(world.ledger.dir, `${moveId}.json`)).taken;
	return importMovedSession({
		bundleDir,
		targetCwd: world.cwdB,
		ledger: holder,
		readIdentity: world.readIdentity,
	}).then(() => "landed", codeOf);
}

function plant(file: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "kept");
}

describe("a commit whose holder lost the move record's lock before its prepare step (senpi#6492)", () => {
	it("#given a read-only copy of the session at the landing, with its resident blobs #when the holder is told its lock was taken as prepare begins #then the copy and its blobs stay and its import fails", async () => {
		const world = await setup();
		const sessionDir = getDefaultSessionDir(world.cwdB);
		const landing = join(sessionDir, basename(world.source));
		const blob = join(sessionDir, "resident-blobs", SESSION_ID, "blob");
		plant(blob);
		// The sender's sealed file is a read-only copy of this session: what an import replaces at its landing.
		copyFileSync(world.source, landing);

		const answer = await importLosingLock(world, MOVE, world.bundleDir);

		expect({ answer, copy: existsSync(landing), blob: existsSync(blob) }).toEqual({
			answer: "ELOCKLOST",
			copy: true,
			blob: true,
		});
	});

	it("#given a bundle that carries extension state, and a file already where that state goes #when the holder is told its lock was taken as prepare begins #then that file stays, no state is copied and its import fails", async () => {
		const world = await setup();
		const source = writeSession(join(world.base, "a2", "repo"));
		const outgoing = join(world.base, "state-out");
		mkdirSync(join(outgoing, "probe"), { recursive: true });
		writeFileSync(join(outgoing, "probe", "state.json"), '{"tasks":3}\n');
		const bundleDir = join(world.base, "bundle-state");
		const moveId = "move-0044" as typeof MOVE;
		await world.ledger.prepare(moveId);
		await exportSessionForMove({
			sessionFile: source,
			moveId,
			target: "device-b",
			droppedUserMessages: [],
			bundleDir,
			extensionStateDir: outgoing,
		});
		const moved = movedStateDir(join(getDefaultSessionDir(world.cwdB), basename(source)), moveId);
		const already = join(moved, "already.json");
		plant(already);

		const answer = await importLosingLock(world, moveId, bundleDir);

		expect({
			answer,
			already: existsSync(already),
			copied: existsSync(join(moved, "probe", "state.json")),
		}).toEqual({ answer: "ELOCKLOST", already: true, copied: false });
	});
});
