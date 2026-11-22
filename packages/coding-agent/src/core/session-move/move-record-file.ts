/**
 * The file a move's record is kept in, one per move in the receiving device's ledger folder: where it is, how a record
 * and its landing are read back from it, how it is replaced whole, and the two checks a commit makes against it.
 */
import { readFile, rename as renameFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMoveId } from "./bundle.ts";
import { type Landing, isCommitStamp, landedElsewhere, landsAt, parseLanding } from "./move-landing.ts";
import type { MoveRecordLocks } from "./move-ledger-lock.ts";
import { MoveFencedError, type MoveRecord, parseRecord } from "./move-record.ts";
import type { MoveId } from "./ownership.ts";

export class MoveRecordFile {
	readonly dir: string;
	readonly #locks: MoveRecordLocks;
	readonly #stamp: () => Readonly<Record<string, unknown>>;

	/**
	 * `locks` is the ledger's own registry: a write here needs the lock the ledger took for the move. `stamp` is what
	 * every write carries beside its time, so a reader on the same machine can age it without the wall clock.
	 */
	constructor(dir: string, locks: MoveRecordLocks, stamp: () => Readonly<Record<string, unknown>> = () => ({})) {
		this.dir = dir;
		this.#locks = locks;
		this.#stamp = stamp;
	}

	path(moveId: MoveId): string {
		return join(this.dir, `${parseMoveId(moveId)}.json`);
	}

	async raw(moveId: MoveId): Promise<unknown> {
		try {
			return JSON.parse(await readFile(this.path(moveId), "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async read(moveId: MoveId): Promise<MoveRecord | undefined> {
		return this.recordIn(moveId, await this.raw(moveId));
	}

	/** The record in what `raw` read: none for no file, and an error for a file that does not hold one. */
	private recordIn(moveId: MoveId, value: unknown): MoveRecord | undefined {
		if (value === undefined) return undefined;
		const record = parseRecord(value);
		if (record === undefined) throw new Error(`Move record ${this.path(moveId)} is not a move record`);
		return record;
	}

	/** Where this move lands (recorded by its first receive) and whether its commit began. */
	async landing(moveId: MoveId): Promise<Landing> {
		return parseLanding(await this.raw(moveId));
	}

	/** Writes the record and answers the time it stamped it with. */
	async write(moveId: MoveId, record: MoveRecord, landing: Landing = {}): Promise<string> {
		const file = this.path(moveId);
		const temp = `${file}.${process.pid}.tmp`;
		const at = new Date().toISOString();
		this.#locks.assertHeld(file);
		await writeFile(temp, `${JSON.stringify({ ...record, ...landing, at, ...this.#stamp() })}\n`);
		this.#locks.assertHeld(file);
		await renameFile(temp, file);
		return at;
	}

	/** A commit goes on only for a receiving move whose commit has not begun, into its target; else what the record says. */
	async assertLandsAt(moveId: MoveId, target: string): Promise<Landing> {
		// One read: the state and the landing come from the same version of the record, whoever else may be writing it.
		const stored = await this.raw(moveId);
		const [record, landing] = [this.recordIn(moveId, stored), parseLanding(stored)];
		if (!landsAt(record, landing, target))
			throw new MoveFencedError(moveId, record, landedElsewhere(record, landing));
		return landing;
	}

	/**
	 * A commit renames only while it still holds the move's lock and the record still carries its own stamp. A holder
	 * that stalled past the lock's stale bound may find the move settled by whoever took the lock: it then renames
	 * nothing, and the refusal says what the record says.
	 */
	async assertStampStands(moveId: MoveId, stamp: string): Promise<void> {
		this.#locks.assertHeld(this.path(moveId));
		const stored = await this.raw(moveId);
		if (isCommitStamp(stored, stamp)) return;
		const record = parseRecord(stored);
		const replaced = record?.state === "receiving" ? "another import's commit took over its record" : undefined;
		throw new MoveFencedError(moveId, record, replaced);
	}
}
