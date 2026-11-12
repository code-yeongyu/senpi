import { mkdir } from "node:fs/promises";
import { serializeByKey } from "../session-sidecar-store.ts";
import {
	type LandingOutcome,
	heldElsewhere,
	landedElsewhere,
	landsAt,
	moveFolder,
	parseLanding,
	type StampClock,
	type StampClockOptions,
	settledAt,
	settledLanding,
	stampAge,
	stampClock,
	stampFields,
} from "./move-landing.ts";
import { MoveRecordLocks } from "./move-ledger-lock.ts";
import { MoveRecordFile } from "./move-record-file.ts";
import { moveStep } from "./move-steps.ts";
import {
	type DeclineReason,
	type FailReason,
	type MoveAnswer,
	MoveFencedError,
	type MoveRecord,
	parseRecord,
} from "./move-record.ts";
import type { MoveId } from "./ownership.ts";

export {
	type DeclineReason,
	type FailReason,
	type MoveAnswer,
	MoveFencedError,
	type MoveRecord,
	type MoveStatus,
	parseMoveStatus,
} from "./move-record.ts";

/** How long a ready move waits for its bundle before it is declined as expired. */
export const READY_TTL_MS = 10 * 60_000;

const FINAL_STATES: readonly MoveRecord["state"][] = ["accepted", "declined", "failed"];

export type MoveLedgerOptions = StampClockOptions;

/** What a receive brings to `beginReceive`. */
export interface BeginReceiveOptions {
	/** The folder the import lands in, resolved as the import resolves it. The record keeps it as `cwd`. */
	readonly cwd?: string;
}

/**
 * The receiving device's record of every move it was offered. Asking about a move is itself a fence: a move this
 * device never heard of is recorded as declined BEFORE the answer leaves, so a later import of it is refused and the
 * sender may safely take its session back. Every writer and the import's final rename share one lock per move.
 */
export class MoveLedger {
	readonly dir: string;
	private readonly clock: StampClock;
	readonly #locks = new MoveRecordLocks();
	readonly #file: MoveRecordFile;

	constructor(dir: string, options: MoveLedgerOptions = {}) {
		this.dir = dir;
		this.clock = stampClock(options);
		this.#file = new MoveRecordFile(dir, this.#locks, () => stampFields(this.clock));
	}

	/**
	 * Says this device can take the move, for `READY_TTL_MS`. Sending ready again keeps the first window; a move already
	 * receiving or accepted stays so, and one already answered otherwise is refused.
	 */
	prepare(moveId: MoveId, folder?: string): Promise<MoveRecord> {
		const cwd = moveFolder(folder);
		return this.locked(moveId, async () => {
			const record = await this.current(moveId);
			const landing = await this.#file.landing(moveId);
			// A move lands in one folder: the first ready that names one fixes it, and the window is never restarted.
			if (cwd !== undefined && landing.cwd !== undefined && landing.cwd !== cwd)
				throw new MoveFencedError(moveId, record, heldElsewhere(landing));
			if (record === undefined) {
				const ready = {
					state: "ready",
					expiresAt: new Date(this.clock.now() + READY_TTL_MS).toISOString(),
				} as const;
				await this.#file.write(moveId, ready, cwd === undefined ? {} : { cwd });
				return ready;
			}
			if (record.state !== "ready" && record.state !== "receiving" && record.state !== "accepted")
				throw new MoveFencedError(moveId, record);
			// A commit stamp is never rewritten: its time is what settles it, and a rewrite would start that time again.
			if (cwd !== undefined && landing.cwd === undefined && landing.committing !== true)
				await this.#file.write(moveId, record, { ...landing, cwd });
			return record;
		});
	}

	/**
	 * Refuses an import into a folder other than the one a ready move was readied for, before the import's own
	 * repository check can answer that folder's repository instead (senpi#6435). It writes nothing and takes no lock:
	 * a record is replaced whole, so one read of it is consistent, and an import must not wait here behind another
	 * import's commit of the same move (senpi#6413). `beginReceive` decides again under the lock.
	 */
	async requireReadiedFor(moveId: MoveId, cwd: string): Promise<void> {
		const stored = await this.#file.raw(moveId);
		const [record, landing] = [parseRecord(stored), parseLanding(stored)];
		if (record?.state === "ready" && landing.cwd !== undefined && landing.cwd !== moveFolder(cwd))
			throw new MoveFencedError(moveId, record, heldElsewhere(landing));
	}

	/**
	 * Starts receiving a verified bundle into `target`, the session file it will land as. Only a move this device readied
	 * (and whose window is still open) may start; a bundle for a move it never readied is declined for good
	 * (`chunk_without_ready`). The first receive records its target and the move lands only there: a receive for another
	 * target is fenced while the move is receiving, and an accepted move never lands again, at any target (a deleted copy
	 * is gone). A receiving record with no target (an older build wrote it) is fenced too: where it landed is unknown,
	 * and a file it already landed is confirmed by the import's same-file check, which runs before this.
	 */
	beginReceive(moveId: MoveId, target: string, options: BeginReceiveOptions = {}): Promise<void> {
		const cwd = moveFolder(options.cwd);
		return this.locked(moveId, async () => {
			const record = await this.current(moveId);
			const landing = await this.#file.landing(moveId);
			const receiving = landsAt(record, landing, target);
			// A move readied or already received for a folder is received only for that folder; one with none keeps this
			// one. The folder itself is compared: two folders can map to the same landing file.
			if ((record?.state === "ready" || receiving) && landing.cwd !== undefined && landing.cwd !== cwd)
				throw new MoveFencedError(moveId, record, heldElsewhere(landing));
			if (record?.state === "ready") {
				await this.#file.write(moveId, { state: "receiving" }, settledAt({ cwd }, target));
				return;
			}
			if (receiving) return;
			if (record?.state === "receiving" || record?.state === "accepted")
				throw new MoveFencedError(moveId, record, landedElsewhere(record, landing));
			if (record !== undefined) throw new MoveFencedError(moveId, record);
			const declined = { state: "declined", reason: "chunk_without_ready" } as const;
			await this.#file.write(moveId, declined);
			throw new MoveFencedError(moveId, declined);
		});
	}

	/** Declines a ready move whose window has passed; any other record is returned unchanged. */
	expire(moveId: MoveId): Promise<MoveRecord | undefined> {
		return this.locked(moveId, () => this.current(moveId));
	}

	/**
	 * The signed answer a sender gets. `movedIn` is whether the session file here records the move, `revoked` whether it
	 * records its revoke too (a revoke whose record write was lost still answers revoked). `landed` reads the file at the
	 * recorded target, so a step a crash interrupted is settled from the files first (`reconcile`).
	 */
	answerStatus(
		moveId: MoveId,
		here: {
			readonly movedIn: boolean;
			readonly revoked?: boolean;
			readonly landed?: (target: string) => LandingOutcome | Promise<LandingOutcome>;
		},
	): Promise<MoveAnswer> {
		return this.locked(moveId, async (): Promise<MoveAnswer> => {
			const record = await this.reconcile(moveId, await this.current(moveId), here.landed);
			if (here.revoked === true) return { state: "accepted", revoked: true } as const;
			if (record?.state === "accepted") return record;
			if (here.movedIn) return { state: "accepted" } as const;
			if (record?.state === "ready") return { state: "receiving" } as const;
			if (record !== undefined) return record;
			const declined = { state: "declined", reason: "no_record" } as const;
			await this.#file.write(moveId, declined);
			return declined;
		});
	}

	/**
	 * Throws unless this process still holds the move's lock. For what a commit's `prepare` removes or copies: each is a
	 * write under this lock, and a holder that lost it must stop before the next one.
	 */
	assertHeld(moveId: MoveId): void {
		this.#locks.assertHeld(this.#file.path(moveId));
	}

	/** Cancel, expiry or a refused chunk: only before the bundle was verified and receiving began, never after. */
	decline(moveId: MoveId, reason: DeclineReason): Promise<MoveRecord> {
		return this.settle(moveId, { state: "declined", reason }, ["receiving"]);
	}

	/**
	 * A verified import that could not finish; it may end a receiving move but never an accepted one. `unlessLanded` is
	 * asked under the move's lock, right before the write: when this move's session file landed (an overlapping import's
	 * commit may land it while this call waits for the lock), nothing is recorded and the current record is returned.
	 */
	fail(
		moveId: MoveId,
		reason: FailReason,
		options: { readonly unlessLanded?: () => boolean | Promise<boolean> } = {},
	): Promise<MoveRecord | undefined> {
		return this.locked(moveId, async () =>
			(await options.unlessLanded?.())
				? this.current(moveId)
				: this.settleLocked(moveId, { state: "failed", reason }, []),
		);
	}

	/**
	 * Runs the import's commit (the atomic rename into `target`) under the move's lock. The record is stamped
	 * `committing` before the rename, so a crash or failure on either side of it never lets the move land again; the
	 * file at the target then decides (`confirmLanded`, `reconcile`). Only the recorded target may be renamed into.
	 * `prepare` runs before the stamp: whatever it does or refuses lands nothing, so a refusal there still records failed.
	 * `rename` is handed `stampStands`, to call right before the step that lands the file: whatever comes before that
	 * step (waiting for the session's lock, rewriting the file) can outlast the lock's stale bound too.
	 */
	commit<T>(
		moveId: MoveId,
		target: string,
		rename: (stampStands: () => Promise<void>) => T | Promise<T>,
		prepare?: () => void | Promise<void>,
	): Promise<T> {
		return this.locked(moveId, async () => {
			await this.#file.assertLandsAt(moveId, target);
			await prepare?.();
			// `prepare` can outlast the lock's stale bound: whoever took the lock may have settled the move since the first
			// look. The stamp's own write refuses a holder that was told its lock is gone.
			const landing = await this.#file.assertLandsAt(moveId, target);
			const stamp = await this.#file.write(
				moveId,
				{ state: "receiving" },
				{ ...settledAt(landing, target), committing: true },
			);
			moveStep("import:stamped");
			const stampStands = () => this.#file.assertStampStands(moveId, stamp);
			await stampStands();
			// The last look before the landing: the stamp check awaited above, and the lock itself, with nothing awaited between.
			this.#locks.assertHeld(this.#file.path(moveId));
			const result = await rename(stampStands);
			moveStep("import:renamed");
			await this.#file.write(moveId, { state: "accepted" }, settledAt(landing, target));
			return result;
		});
	}

	/**
	 * The import found this move's file already landed at `target`: that file proves the commit, so a record a crash
	 * left `receiving`, committing or lost becomes accepted there, and revoked when the file is (`revoked`). A target
	 * other than the recorded one is fenced; an accepted record only gains a revoke mark it was missing.
	 */
	confirmLanded(moveId: MoveId, target: string, revoked: boolean): Promise<void> {
		return this.locked(moveId, async () => {
			const record = await this.#file.read(moveId);
			const landing = await this.#file.landing(moveId);
			const open = record === undefined || record.state === "receiving" || record.state === "accepted";
			if (!open || (landing.target !== undefined && landing.target !== target))
				throw new MoveFencedError(moveId, record, landedElsewhere(record, landing));
			const marked = record?.state === "accepted" && "revoked" in record;
			if (record?.state === "accepted" && (marked || !revoked)) return;
			await this.#file.write(
				moveId,
				revoked ? { state: "accepted", revoked: true } : { state: "accepted" },
				settledAt(landing, target),
			);
		});
	}

	/**
	 * Settles a step a crash interrupted, from the file at the recorded target: a committing record becomes accepted
	 * (revoked if the file is) when its file landed and failed when it did not, once its stamp is old enough that no
	 * stalled commit can still land it (`COMMIT_SETTLE_AFTER_MS`), and an accepted record whose file is sealed gains its
	 * revoke mark. Without `landed`, or without a recorded target, the record is returned as it is.
	 */
	private async reconcile(
		moveId: MoveId,
		record: MoveRecord | undefined,
		landed: ((target: string) => LandingOutcome | Promise<LandingOutcome>) | undefined,
	): Promise<MoveRecord | undefined> {
		const stored = await this.#file.raw(moveId);
		const { target, cwd, committing } = parseLanding(stored);
		if (landed === undefined || target === undefined) return record;
		const next = settledLanding(record, committing === true, await landed(target), stampAge(stored, this.clock));
		if (next === undefined) return record;
		await this.#file.write(moveId, next, settledAt({ cwd }, target));
		return next;
	}

	/**
	 * Records the revoke of this move's import on its accepted record (`revoked: true`; the state stays `accepted`). The
	 * import committed, so a record lost or left `receiving` by a crash becomes accepted and revoked; a repeat changes
	 * nothing, and any other record is left alone.
	 */
	markRevoked(moveId: MoveId): Promise<void> {
		return this.locked(moveId, async () => {
			const record = await this.#file.read(moveId);
			if (record !== undefined && record.state !== "receiving" && record.state !== "accepted") return;
			if (record?.state === "accepted" && "revoked" in record) return;
			const landing = await this.#file.landing(moveId);
			await this.#file.write(
				moveId,
				{ state: "accepted", revoked: true },
				landing.target === undefined ? {} : settledAt(landing, landing.target),
			);
		});
	}

	/**
	 * Records a final answer unless one is already there: once a sender may have heard `accepted`, `declined` or
	 * `failed`, it never changes. Reads through `current()`, so a ready move whose window passed answers `expired`.
	 * `keeps` names the open states this transition must also leave alone. A record stamped `committing` is never
	 * settled here: its rename may have landed a copy, so only the file at its target settles it (`reconcile`).
	 */
	private settle(moveId: MoveId, next: MoveRecord, keeps: readonly MoveRecord["state"][]): Promise<MoveRecord> {
		return this.locked(moveId, () => this.settleLocked(moveId, next, keeps));
	}

	/** `settle` for a caller that already holds the move's lock. */
	private async settleLocked(
		moveId: MoveId,
		next: MoveRecord,
		keeps: readonly MoveRecord["state"][],
	): Promise<MoveRecord> {
		const record = await this.current(moveId);
		if (record !== undefined && (FINAL_STATES.includes(record.state) || keeps.includes(record.state))) return record;
		if (record !== undefined && (await this.#file.landing(moveId)).committing === true) return record;
		await this.#file.write(moveId, next);
		return next;
	}

	/** The record, with a ready move whose window has passed declined as expired first (on disk, under the lock). */
	private async current(moveId: MoveId): Promise<MoveRecord | undefined> {
		const record = await this.#file.read(moveId);
		if (record?.state !== "ready" || this.clock.now() < Date.parse(record.expiresAt)) return record;
		const expired = { state: "declined", reason: "expired" } as const;
		await this.#file.write(moveId, expired);
		return expired;
	}

	private locked<T>(moveId: MoveId, fn: () => T | Promise<T>): Promise<T> {
		const file = this.#file.path(moveId);
		return serializeByKey(file, async () => {
			await mkdir(this.dir, { recursive: true });
			return this.#locks.hold(file, fn);
		});
	}
}
