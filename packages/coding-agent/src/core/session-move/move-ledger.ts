import { mkdir, readFile, rename as renameFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serializeByKey } from "../session-sidecar-store.ts";
import { parseMoveId } from "./bundle.ts";
import {
	type Landing,
	type LandingOutcome,
	landedElsewhere,
	landsAt,
	parseLanding,
	settledLanding,
} from "./move-landing.ts";
import { MoveRecordLocks } from "./move-ledger-lock.ts";
import { moveStep } from "./move-steps.ts";
import type { MoveId } from "./ownership.ts";

/**
 * The receiving device's record of every move it was offered. Asking about a move is itself a fence: a move this
 * device never heard of is recorded as declined BEFORE the answer leaves, so a later import of it is refused and the
 * sender may safely take its session back. Every writer and the import's final rename share one lock per move.
 */
export type DeclineReason = "no_record" | "expired" | "cancelled" | "chunk_without_ready" | "repository";
export type FailReason = "bundle_invalid" | "import_failed";

/** The answers a sender can hear. */
export type MoveStatus =
	| { readonly state: "receiving" }
	| { readonly state: "accepted" }
	| { readonly state: "declined"; readonly reason: DeclineReason }
	| { readonly state: "failed"; readonly reason: FailReason };

/**
 * A status answer as the sender hears it. `revoked` marks an accepted import the receiver later sealed with `revoke`:
 * the record stays `accepted` (final), but the receiver's copy is read-only, so the sender must take the session back.
 */
export type MoveAnswer = MoveStatus | { readonly state: "accepted"; readonly revoked: true };

/** `ready`: this device told the sender it can take the move; no bundle has been verified yet. */
export type MoveRecord = MoveAnswer | { readonly state: "ready"; readonly expiresAt: string };

/** How long a ready move waits for its bundle before it is declined as expired. */
export const READY_TTL_MS = 10 * 60_000;

const FINAL_STATES: readonly MoveRecord["state"][] = ["accepted", "declined", "failed"];

export interface MoveLedgerOptions {
	readonly now?: () => number;
}

export class MoveFencedError extends Error {
	readonly code = "move_fenced";
	readonly record: MoveRecord | undefined;

	constructor(moveId: MoveId, record: MoveRecord | undefined, detail?: string) {
		super(
			`Move ${moveId} can no longer be imported here: ${detail ?? `it was already answered (${record?.state ?? "no record"})`}.`,
		);
		this.name = "MoveFencedError";
		this.record = record;
	}
}

const DECLINE_REASONS: readonly DeclineReason[] = [
	"no_record",
	"expired",
	"cancelled",
	"chunk_without_ready",
	"repository",
];
const FAIL_REASONS: readonly FailReason[] = ["bundle_invalid", "import_failed"];

/** A receiver's answer as it arrives back at the sender; a `ready` record is not an answer. */
export function parseMoveStatus(value: unknown): MoveAnswer | undefined {
	const record = parseRecord(value);
	return record?.state === "ready" ? undefined : record;
}

function parseRecord(value: unknown): MoveRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { state, reason } = value as { readonly state?: unknown; readonly reason?: unknown };
	if (state === "accepted" && (value as { readonly revoked?: unknown }).revoked === true)
		return { state, revoked: true };
	if (state === "receiving") return { state };
	if (state === "accepted") return { state };
	const { expiresAt } = value as { readonly expiresAt?: unknown };
	if (state === "ready" && typeof expiresAt === "string" && !Number.isNaN(Date.parse(expiresAt)))
		return { state, expiresAt };
	const decline = DECLINE_REASONS.find((known) => known === reason);
	if (state === "declined" && decline !== undefined) return { state, reason: decline };
	const fail = FAIL_REASONS.find((known) => known === reason);
	if (state === "failed" && fail !== undefined) return { state, reason: fail };
	return undefined;
}

export class MoveLedger {
	readonly dir: string;
	private readonly now: () => number;
	readonly #locks = new MoveRecordLocks();

	constructor(dir: string, options: MoveLedgerOptions = {}) {
		this.dir = dir;
		this.now = options.now ?? Date.now;
	}

	/**
	 * Says this device can take the move, for `READY_TTL_MS`. Sending ready again keeps the first window; a move already
	 * receiving or accepted stays so, and one already answered otherwise is refused.
	 */
	prepare(moveId: MoveId): Promise<MoveRecord> {
		return this.locked(moveId, async () => {
			const record = await this.current(moveId);
			if (record === undefined) {
				const ready = { state: "ready", expiresAt: new Date(this.now() + READY_TTL_MS).toISOString() } as const;
				await this.write(moveId, ready);
				return ready;
			}
			if (record.state === "ready" || record.state === "receiving" || record.state === "accepted") return record;
			throw new MoveFencedError(moveId, record);
		});
	}

	/**
	 * Starts receiving a verified bundle into `target`, the session file it will land as. Only a move this device readied
	 * (and whose window is still open) may start; a bundle for a move it never readied is declined for good
	 * (`chunk_without_ready`). The first receive records its target and the move lands only there: a receive for another
	 * target is fenced while the move is receiving, and an accepted move never lands again, at any target (a deleted copy
	 * is gone). A receiving record with no target (an older build wrote it) is fenced too: where it landed is unknown,
	 * and a file it already landed is confirmed by the import's same-file check, which runs before this.
	 */
	beginReceive(moveId: MoveId, target: string): Promise<void> {
		return this.locked(moveId, async () => {
			const record = await this.current(moveId);
			const landing = await this.landing(moveId);
			if (record?.state === "ready") {
				await this.write(moveId, { state: "receiving" }, { target });
				return;
			}
			if (landsAt(record, landing, target)) return;
			if (record?.state === "receiving" || record?.state === "accepted")
				throw new MoveFencedError(moveId, record, landedElsewhere(record, landing));
			if (record !== undefined) throw new MoveFencedError(moveId, record);
			const declined = { state: "declined", reason: "chunk_without_ready" } as const;
			await this.write(moveId, declined);
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
			await this.write(moveId, declined);
			return declined;
		});
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
	 */
	commit<T>(
		moveId: MoveId,
		target: string,
		rename: () => T | Promise<T>,
		prepare?: () => void | Promise<void>,
	): Promise<T> {
		return this.locked(moveId, async () => {
			const record = await this.read(moveId);
			const landing = await this.landing(moveId);
			if (!landsAt(record, landing, target))
				throw new MoveFencedError(moveId, record, landedElsewhere(record, landing));
			await prepare?.();
			await this.write(moveId, { state: "receiving" }, { target, committing: true });
			moveStep("import:stamped");
			const result = await rename();
			moveStep("import:renamed");
			await this.write(moveId, { state: "accepted" }, { target });
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
			const record = await this.read(moveId);
			const landing = await this.landing(moveId);
			const open = record === undefined || record.state === "receiving" || record.state === "accepted";
			if (!open || (landing.target !== undefined && landing.target !== target))
				throw new MoveFencedError(moveId, record, landedElsewhere(record, landing));
			const marked = record?.state === "accepted" && "revoked" in record;
			if (record?.state === "accepted" && (marked || !revoked)) return;
			await this.write(moveId, revoked ? { state: "accepted", revoked: true } : { state: "accepted" }, { target });
		});
	}

	/**
	 * Settles a step a crash interrupted, from the file at the recorded target: a committing record becomes accepted
	 * (revoked if the file is) when its file landed and failed when it did not, and an accepted record whose file is
	 * sealed gains its revoke mark. Without `landed`, or without a recorded target, the record is returned as it is.
	 */
	private async reconcile(
		moveId: MoveId,
		record: MoveRecord | undefined,
		landed: ((target: string) => LandingOutcome | Promise<LandingOutcome>) | undefined,
	): Promise<MoveRecord | undefined> {
		const { target, committing } = await this.landing(moveId);
		if (landed === undefined || target === undefined) return record;
		const next = settledLanding(record, committing === true, await landed(target));
		if (next === undefined) return record;
		await this.write(moveId, next, { target });
		return next;
	}

	/**
	 * Records the revoke of this move's import on its accepted record (`revoked: true`; the state stays `accepted`). The
	 * import committed, so a record lost or left `receiving` by a crash becomes accepted and revoked; a repeat changes
	 * nothing, and any other record is left alone.
	 */
	markRevoked(moveId: MoveId): Promise<void> {
		return this.locked(moveId, async () => {
			const record = await this.read(moveId);
			if (record !== undefined && record.state !== "receiving" && record.state !== "accepted") return;
			if (record?.state === "accepted" && "revoked" in record) return;
			const { target } = await this.landing(moveId);
			await this.write(moveId, { state: "accepted", revoked: true }, target === undefined ? {} : { target });
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
		if (record !== undefined && (await this.landing(moveId)).committing === true) return record;
		await this.write(moveId, next);
		return next;
	}

	/** The record, with a ready move whose window has passed declined as expired first (on disk, under the lock). */
	private async current(moveId: MoveId): Promise<MoveRecord | undefined> {
		const record = await this.read(moveId);
		if (record?.state !== "ready" || this.now() < Date.parse(record.expiresAt)) return record;
		const expired = { state: "declined", reason: "expired" } as const;
		await this.write(moveId, expired);
		return expired;
	}

	private path(moveId: MoveId): string {
		return join(this.dir, `${parseMoveId(moveId)}.json`);
	}

	private async raw(moveId: MoveId): Promise<unknown> {
		try {
			return JSON.parse(await readFile(this.path(moveId), "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	private async read(moveId: MoveId): Promise<MoveRecord | undefined> {
		const value = await this.raw(moveId);
		if (value === undefined) return undefined;
		const record = parseRecord(value);
		if (record === undefined) throw new Error(`Move record ${this.path(moveId)} is not a move record`);
		return record;
	}

	/** Where this move lands (recorded by its first receive) and whether its commit began. */
	private async landing(moveId: MoveId): Promise<Landing> {
		return parseLanding(await this.raw(moveId));
	}

	private async write(moveId: MoveId, record: MoveRecord, landing: Landing = {}): Promise<void> {
		const file = this.path(moveId);
		const temp = `${file}.${process.pid}.tmp`;
		this.#locks.assertHeld(file);
		await writeFile(temp, `${JSON.stringify({ ...record, ...landing, at: new Date().toISOString() })}\n`);
		this.#locks.assertHeld(file);
		await renameFile(temp, file);
	}

	private locked<T>(moveId: MoveId, fn: () => T | Promise<T>): Promise<T> {
		const file = this.path(moveId);
		return serializeByKey(file, async () => {
			await mkdir(this.dir, { recursive: true });
			return this.#locks.hold(file, fn);
		});
	}
}
