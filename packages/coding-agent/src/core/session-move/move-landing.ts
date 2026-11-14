import { hostname, uptime } from "node:os";
import { resolvePath } from "../../utils/paths.ts";
import { MOVE_RECORD_LOCK_STALE_MS } from "./move-ledger-lock.ts";
import type { MoveRecord } from "./move-record.ts";

/**
 * How old a commit stamp with no landed file must be before it is settled as failed (senpi#6417). A commit holds its
 * record's lock from its stamp to its rename, so a stamp with no file, read under that lock, was left by a commit that
 * failed, died, or stalled until its lock went stale and was taken over. Only a stalled one can still rename, when it
 * runs again; this gives it three stale bounds to land its file or to learn that its lock is gone.
 */
export const COMMIT_SETTLE_AFTER_MS = 3 * MOVE_RECORD_LOCK_STALE_MS;

/**
 * `os.uptime()` reads whole seconds on one runtime and fractions on another, so a reader can read a little less than
 * the writer did. An uptime lower than the stamp's by more than this means the machine restarted since the stamp.
 */
const UPTIME_RESOLUTION_MS = 2_000;

/** The clocks a record is stamped and aged with. Tests replace them; nothing else does. */
export interface StampClockOptions {
	/** The wall clock, in ms. It can be stepped, in either direction. */
	readonly now?: () => number;
	/** Ms since this machine started: one clock for every process on it, which a wall-clock step does not move. */
	readonly uptime?: () => number;
	/** The machine `uptime` belongs to. */
	readonly host?: string;
}

export type StampClock = Required<StampClockOptions>;

export function stampClock(options: StampClockOptions = {}): StampClock {
	return {
		now: options.now ?? Date.now,
		uptime: options.uptime ?? (() => uptime() * 1000),
		host: options.host ?? hostname(),
	};
}

/** What a record carries beside its `at`, so a reader on the same machine can age it without the wall clock. */
export interface UptimeStamp {
	readonly up: number;
	readonly host: string;
}

export function stampFields(clock: StampClock): UptimeStamp {
	return { up: Math.round(clock.uptime()), host: clock.host };
}

/** How long ago a record was written by the wall clock, from its `at`; `undefined` when it carries none. */
function wallAge(value: unknown, now: number): number | undefined {
	if (typeof value !== "object" || value === null || !("at" in value) || typeof value.at !== "string")
		return undefined;
	const at = Date.parse(value.at);
	return Number.isNaN(at) ? undefined : now - at;
}

/**
 * How long ago a record was written by its machine's uptime. `undefined` when that clock cannot say: another machine
 * wrote the record, an older build did (no `up`), or this machine restarted since (its uptime reads lower).
 */
function machineAge(value: unknown, clock: StampClock): number | undefined {
	if (typeof value !== "object" || value === null || !("up" in value) || !("host" in value)) return undefined;
	if (typeof value.up !== "number" || value.host !== clock.host) return undefined;
	const age = clock.uptime() - value.up;
	return age < -UPTIME_RESOLUTION_MS ? undefined : Math.max(0, age);
}

/**
 * The age a commit stamp is settled by. The wall clock alone misjudges it after a step: stepped forward, a healthy
 * commit's stamp reads old at once and is settled failed while that commit can still land its file. So a stamp is old
 * only when both clocks say so: while the machine's uptime calls it young that age is the answer, and otherwise the
 * wall clock's is (negative after a step back, which `settledLanding` counts as old). Erring young only delays the
 * settling of a commit that died, and by at most the bound of whichever clock is wrong.
 */
export function stampAge(value: unknown, clock: StampClock): number | undefined {
	const machine = machineAge(value, clock);
	return machine !== undefined && machine < COMMIT_SETTLE_AFTER_MS ? machine : wallAge(value, clock.now());
}

/** Whether a stored record is still the commit stamp that was written at `stamp`. */
export function isCommitStamp(value: unknown, stamp: string): boolean {
	if (typeof value !== "object" || value === null || !("at" in value)) return false;
	return value.at === stamp && parseLanding(value).committing === true;
}

/** What the session file at a move's landing target records for the move. */
export type LandingOutcome = "absent" | "moved_in" | "revoked";

/** The hidden part of a move record: where the move lands, and whether its commit began. Never part of an answer. */
export interface Landing {
	readonly target?: string;
	/**
	 * The folder this move was readied for and lands in, resolved as the import resolves its `cwd` (senpi#6435).
	 * Whoever readies the move writes it: the target's `prepare` once it checked that folder's repository, or an
	 * import that readies the move itself, with its own folder. From then on the move lands only there.
	 */
	readonly cwd?: string;
	readonly committing?: true;
}

export function parseLanding(value: unknown): Landing {
	if (typeof value !== "object" || value === null) return {};
	const { target, cwd, committing } = value as { target?: unknown; cwd?: unknown; committing?: unknown };
	return {
		...(typeof target === "string" ? { target } : {}),
		...(typeof cwd === "string" ? { cwd } : {}),
		...(committing === true ? { committing: true } : {}),
	};
}

/** What a write keeps of a landing: where the move lands and the folder it was readied for, never the commit stamp. */
export function settledAt(landing: Landing, target: string): Landing {
	return landing.cwd === undefined ? { target } : { target, cwd: landing.cwd };
}

/**
 * The one spelling a move's folder is kept and compared in (senpi#6435): resolved as the import resolves its `cwd`,
 * so a trailing slash, a `.` or `..` segment or a doubled slash still names the same folder at every step.
 */
export function moveFolder(cwd: string | undefined): string | undefined {
	return cwd === undefined ? undefined : resolvePath(cwd);
}

/** Why a move readied for one folder refuses another: it lands only where its repository was checked (senpi#6435). */
export function heldElsewhere(landing: Landing): string {
	return `it was readied for ${landing.cwd ?? "another folder"} and lands only there`;
}

/**
 * What a record becomes once the file at its target settles a step a crash interrupted: a committing record is
 * accepted (revoked if the file is) when its file landed and failed when it did not, and an accepted record whose file
 * is sealed gains its revoke mark. `undefined` when the record already agrees with the file, and while a commit stamp
 * with no file is younger than `COMMIT_SETTLE_AFTER_MS` (`stampAge`). A stamp with no known age counts as old, and so
 * does one dated after now: the clock stepped back since it was written, and its age would stay negative, and the
 * move unsettled, for as long as the step.
 */
export function settledLanding(
	record: MoveRecord | undefined,
	committing: boolean,
	outcome: LandingOutcome,
	stampAge?: number,
): MoveRecord | undefined {
	if (record?.state === "receiving" && committing) {
		if (outcome === "absent")
			return stampAge !== undefined && stampAge >= 0 && stampAge < COMMIT_SETTLE_AFTER_MS
				? undefined
				: { state: "failed", reason: "import_failed" };
		return outcome === "revoked" ? { state: "accepted", revoked: true } : { state: "accepted" };
	}
	if (record?.state === "accepted" && !("revoked" in record) && outcome === "revoked")
		return { state: "accepted", revoked: true };
	return undefined;
}

/** Whether an import into `target` may proceed: only a receiving move whose commit has not begun, into its target. */
export function landsAt(record: MoveRecord | undefined, landing: Landing, target: string): boolean {
	return record?.state === "receiving" && landing.committing !== true && landing.target === target;
}

export function landedElsewhere(record: MoveRecord | undefined, landing: Landing): string | undefined {
	const stored = landing.target;
	if (record?.state === "accepted" && "revoked" in record) return "it was revoked here and never lands again";
	if (record?.state === "receiving" && landing.committing === true)
		return "an import of it stopped mid-commit, and a move lands once; only the file it landed is accepted";
	if (record?.state === "accepted")
		return "it already landed here once, and a move lands once (a deleted copy is gone; copy the session to a new thread instead)";
	if (record?.state === "receiving" && stored === undefined)
		return "an older version started receiving it and where it landed is unknown; only its already landed file is accepted";
	return stored === undefined ? undefined : `it lands only as ${stored}`;
}
