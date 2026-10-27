/**
 * Recovery of an abandoned reservation generation (sisyphuslabs/omo-desktop-app#4199, design 4.2a "Crash, cancellation
 * and commit", "Recovery transaction order", Revision 7 "Probe set" and "Admissibility", Revision 8 "Process evidence and
 * the kernel-session gate"). Windows public endpoints only; the caller holds the endpoint lock.
 *
 * Order, per generation that is not retired: (2) fence it (`cancelling`, offers revoked) in one short transaction;
 * (3) probe the presence objects of the probe set (the reserving owner until its `released`, every granted role without
 * `released`) one nonblocking attempt each, in presence-ID order, outside every state transaction; a busy object ends
 * the attempt as occupied whatever other evidence says, and an inadmissible or failed acquisition is unknown unless the
 * exact process proof discharges that entry; (4) reread the generation, recompute the probe set at its revision and drop
 * what committed `released` meanwhile; (5) take the census of every recorded supervisor, host child and session claim,
 * then retire at the revalidated revision while still holding every recovered guard, and only then release them.
 *
 * Process evidence of a row another invocation wrote counts only on a store that recorded `local` and still classifies
 * `local` (clause iii), or when the row's and this prober's kernel sessions are both verified and equal (clauses i, iv).
 * On Windows the evidence is the bridge's retained-handle adapter (design 4.2a "OS identity"): a reopened PID is the
 * recorded process only when `GetProcessId`, the exact creation FILETIME and the `TokenUser` SID all match on that one
 * handle; a different creation time is gone, a same-birth SID mismatch or handle/PID inconsistency is
 * `owner_identity_inconsistent`, an unreadable answer stays unknown (`process-evidence.ts`). A record without a SID
 * (the start-time reader's domain) is never compared against a handle's reading, nor a SID-bearing one against the
 * reader's: such an observation is incomplete.
 * A census row (a generation pidfile, a host-child pidfile, a session claim) carries only the provenance its own launch
 * recorded beside it (launch-provenance.ts: the owner's kernel session and the daemon directory's classification at the
 * write), never the reservation store's locality or the owner's session by default; a row with no provenance stays
 * unknown. A row whose identity is a recorded authority of the generation is that actor's own entry and is discharged
 * by that actor's proof (its `released` commit, an admissible acquisition or the exact process proof), so a quiescent
 * actor that stays alive doing unrelated work does not block. Incomplete discovery (a directory or record that cannot
 * be read) is unknown, never nothing to find. The prior-boot proof and the repair anchor resolve only entries provably
 * from the boot they ended, and only after an observation could not decide them.
 * A FILETIME is compared exactly, as a decimal integer string, never through milliseconds or a tolerance. Nothing here
 * mutates the credential, signals a process, deletes a record, or waits for a lock.
 *
 * Presence cleanup (Revision 7): a probe that finds no object rereads the row, because every deletion is preceded by
 * a `released` commit; an entry released meanwhile is discharged by that commit, and a missing object for an entry
 * that is not stays unknown. After the retirement commit and the release of the recovered guards, the retired
 * generation's objects are deleted through exclusive opens; an object another handle holds is left for the sweep.
 *
 * Bounded escalation (design 4.2a "Bounded unknown escalation", Revision 6 "Fresh evidence after escalation"): a
 * recorded identity gets an initial observation and at most one fresh requery, inside the smaller of the caller's
 * remaining deadline and five seconds; that is a diagnostic budget, never a lease or a death threshold. What is still
 * unknown then is persisted on the reservation as an escalated reason at the revision read, and refused typed with the
 * Repair action it calls for. An unchanged record answers a later automatic attempt from that marker without a new
 * query, while the presence census and the boot evidence are still checked once per invocation; an explicit repair
 * (`fresh`) opens one new bounded assessment; a transition discards the marker. A query that answers after its budget
 * ended is discarded. The guard a busy-owner wait acquired (`held`) is step 3's acquisition of that object.
 */
import { readdir, readFile } from "node:fs/promises";
import {
	type AuthorityEntry,
	EndpointReservationError,
	type EndpointReservationStore,
	type KernelSessionRecord,
	type PresenceObjectRecord,
	type RecoveryEscalationReason,
	type RecoveryProof,
	type ReservationRow,
	type RoleRow,
} from "./endpoint-reservation-store.ts";
import { generationPaths, type HostDaemonDirectory } from "./host-daemon-paths.ts";
import type {
	RecoveryAction,
	RecoveryEscalation,
	RecoveryHolder,
	ReservationRecoveryRefusal,
} from "./host-decision.ts";
import { readSessionPathClaimsCompletely } from "./host-reservations.ts";
import { readLaunchProvenanceRecord } from "./launch-provenance.ts";
import { deletePresenceObject } from "./presence-cleanup.ts";
import { kernelSession } from "./presence-placement.ts";
import {
	classifyObservation,
	identityReaderEvidence,
	nativeProcessEvidence,
	type ProcessEvidence,
	type ProcessObservation,
	type ProcessRecord,
	processRecordKey,
} from "./process-evidence.ts";
import type { PresencePlacementLoad } from "./socket-secret-native.ts";

/** What recovery could not resolve; each is a typed refusal, never a deadline or a guess. */
export type RecoveryRefusal = ReservationRecoveryRefusal["reason"];

export type RecoveryOutcome =
	| { readonly status: "recovered"; readonly generations: readonly string[] }
	| (ReservationRecoveryRefusal & {
			readonly status: "refused";
			readonly detail: string;
			/** For `presence_occupied`: the held object, which a busy-owner wait may wait for. */
			readonly occupied?: PresenceObjectRecord;
	  });

/** The clock the observation budget is measured on; a test drives a fake one and fires its deadline as an event. */
export interface RecoveryClock {
	/** Monotonic milliseconds. */
	now(): number;
	/** Resolves once `ms` have passed: the budget's deadline. */
	deadline(ms: number): Promise<void>;
}

/** A presence guard a busy-owner wait acquired before this attempt; step 3's acquisition of that object. */
export interface RecoveredGuard {
	readonly presenceId: string;
	/** Closes the guard after the retirement commit, or at once when the attempt cannot retire. Idempotent. */
	release(): void;
}

/**
 * The probing invocation's own view: its bridge, its kernel session, how the store directory classifies now, and how
 * the endpoint's daemon directory (where the census rows live) classifies now.
 */
export interface RecoveryProber {
	readonly native: PresencePlacementLoad;
	readonly session: KernelSessionRecord;
	readonly storeLocalNow: boolean;
	readonly daemonDirectoryLocalNow: boolean;
	/** One new observation of a recorded PID: through the bridge's handle on Windows, the identity reader elsewhere. */
	readonly observe: (pid: number) => Promise<ProcessObservation>;
	readonly clock: RecoveryClock;
	/** The caller's remaining startup deadline; the observation budget is the smaller of it and five seconds. */
	readonly remainingMs: number;
	/** An explicit repair: one new bounded assessment even for an unchanged escalated record. */
	readonly fresh: boolean;
	readonly held: RecoveredGuard | undefined;
}

export interface RecoveryProberOptions {
	readonly observe?: (pid: number) => Promise<ProcessObservation>;
	/** The endpoint's daemon directory, classified from its opened handle; without it census rows get no clause (iii). */
	readonly daemonDirectory?: string;
	readonly clock?: RecoveryClock;
	readonly remainingMs?: number;
	readonly fresh?: boolean;
	readonly held?: RecoveredGuard;
}

/** The design's budget: at most two observations within five seconds, or the shorter caller deadline. */
export const OBSERVATION_BUDGET_MS = 5_000;

/**
 * "Reopening a stored PID yields a new observation, not renewed authority": each observation opens the PID, reads its
 * facts on that handle and closes it; nothing recovery observes is retained.
 */
function observeThrough(evidence: ProcessEvidence): (pid: number) => Promise<ProcessObservation> {
	return async (pid) => {
		const retained = await evidence.open(pid);
		try {
			return retained.observation;
		} finally {
			retained.close();
		}
	};
}

const realClock: RecoveryClock = {
	now: () => performance.now(),
	deadline: (ms) =>
		new Promise((resolve) => {
			setTimeout(resolve, ms).unref();
		}),
};

/** Reads this invocation's kernel session and classifies the store directory from its opened handle, once. */
export function recoveryProber(
	storeDirectory: string,
	native: PresencePlacementLoad,
	options: RecoveryProberOptions = {},
): RecoveryProber {
	const common = {
		native,
		observe:
			options.observe ??
			observeThrough(
				native.status === "available"
					? nativeProcessEvidence(native.native)
					: identityReaderEvidence(OBSERVATION_BUDGET_MS),
			),
		clock: options.clock ?? realClock,
		remainingMs: options.remainingMs ?? OBSERVATION_BUDGET_MS,
		fresh: options.fresh ?? false,
		held: options.held,
	};
	if (native.status !== "available") {
		return {
			...common,
			session: { status: "unverified", reason: native.reason },
			storeLocalNow: false,
			daemonDirectoryLocalNow: false,
		};
	}
	const local = (directory: string) => native.native.classifyVolume(directory).locality === "local";
	return {
		...common,
		session: kernelSession(native.native.kernelSessionIdentity()),
		storeLocalNow: local(storeDirectory),
		daemonDirectoryLocalNow: options.daemonDirectory !== undefined && local(options.daemonDirectory),
	};
}

/** Clause (iv): `unverified` equals nothing, another `unverified` included. */
function sameSession(a: KernelSessionRecord, b: KernelSessionRecord): boolean {
	return a.status === "verified" && b.status === "verified" && a.value === b.value;
}

/** Recorded `local`: its presence root was placed beside the store, which only a `local` store gets. */
function recordedLocal(reservation: ReservationRow): boolean {
	return reservation.presence.root.status === "placed" && reservation.presence.root.placement === "beside_store";
}

function describeSession(session: KernelSessionRecord): string {
	return session.status === "verified" ? `session ${session.value}` : `session unverified (${session.reason})`;
}

/** An actor that may still hold authority in a fenced generation. */
interface AuthorityHolder {
	readonly entry: AuthorityEntry;
	/** The recorded identity, `{"pid":..,"processStartTime":..}`. */
	readonly identity: string;
	readonly presence: PresenceObjectRecord;
	/** The kernel session the row recorded; a row without a presence object inherits its launch's owner session. */
	readonly session: KernelSessionRecord;
}

function holderSession(presence: PresenceObjectRecord, reservation: ReservationRow): KernelSessionRecord {
	return presence.status === "predeclared" ? presence.kernelSession : reservation.presence.ownerKernelSession;
}

/**
 * The Revision 7 probe set, in deterministic presence-ID order (holders without an object last): the reserving owner
 * until its `released`, every role that reached `granted` without `released`. Offered and claimed-but-ungranted roles
 * never held authority to spawn or listen, and the fence discharges them.
 */
function probeSet(reservation: ReservationRow, roles: readonly RoleRow[]): AuthorityHolder[] {
	const holders: AuthorityHolder[] = [];
	if (reservation.ownerStatus !== "released") {
		holders.push({
			entry: "owner",
			identity: reservation.owner,
			presence: reservation.ownerPresence,
			session: holderSession(reservation.ownerPresence, reservation),
		});
	}
	for (const row of roles) {
		if (row.status !== "granted") continue;
		holders.push({
			entry: row.role,
			identity: row.participant ?? "",
			presence: row.presence,
			session: holderSession(row.presence, reservation),
		});
	}
	const key = (holder: AuthorityHolder) =>
		holder.presence.status === "predeclared" ? `0${holder.presence.presenceId}` : `1${holder.entry}`;
	return holders.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

type Acquisition =
	| { readonly kind: "acquired"; release(): void }
	| { readonly kind: "occupied" }
	| { readonly kind: "unknown"; readonly reason: string; readonly notFound: boolean; readonly accessDenied: boolean };

/** ERROR_FILE_NOT_FOUND and ERROR_PATH_NOT_FOUND: the recorded path names no object now. */
const NOT_FOUND_CODES = new Set([2, 3]);
/** ERROR_ACCESS_DENIED: the presence store refused this prober; restoring access is the precise remaining step. */
const ACCESS_DENIED_CODE = 5;

/**
 * One nonblocking acquisition of a recorded object. The bridge keeps the guard only when it is admissible: rule 1 (tag
 * and physical identity), rule 2 (recorded `local`, and the object's own handle `local` now) and, for a relocated
 * object, rule 3 (the row's and this kernel's sessions verified and equal). Anything else it releases at once.
 *
 * The guard a busy-owner wait acquired (Revision 8, r7 note 4) is this step's acquisition of its object: the same
 * admissibility rules are applied to the retained handle, which is never closed and reacquired; an inadmissible handle
 * is released at once and the object counts `unknown`.
 */
function acquire(object: PresenceObjectRecord, reservation: ReservationRow, prober: RecoveryProber): Acquisition {
	const unknown = (reason: string, code?: number | null): Acquisition => ({
		kind: "unknown",
		reason,
		notFound: NOT_FOUND_CODES.has(code ?? -1),
		accessDenied: code === ACCESS_DENIED_CODE,
	});
	if (object.status !== "predeclared") return unknown("presence_unavailable");
	if (prober.native.status !== "available") return unknown(prober.native.reason);
	const bridge = prober.native.native;
	const relocated =
		reservation.presence.root.status === "placed" && reservation.presence.root.placement === "relocated";
	const request = {
		presenceId: object.presenceId,
		path: object.path,
		header: Buffer.from(object.header, "hex"),
		volumeSerial: object.volumeSerial,
		fileId: object.fileId,
		createdLocal: object.classification === "local",
		relocated,
		kernelSession: object.kernelSession.status === "verified" ? object.kernelSession.value : null,
	};
	const held = prober.held?.presenceId === object.presenceId ? prober.held : undefined;
	const result = held ? bridge.presenceProbeRetained(request) : bridge.presenceProbe(request);
	if (result.status === "occupied") return { kind: "occupied" };
	if (result.status !== "acquired") {
		const code = result.status === "unknown" && result.reason === "os_error" ? result.code : undefined;
		return unknown("reason" in result ? `${result.status}:${result.reason}` : result.status, code);
	}
	return {
		kind: "acquired",
		// The retirement commit is this guard's quiescence receipt; it is closed only after it, or when the attempt ends.
		release: () =>
			held
				? held.release()
				: bridge.presenceReleaseAfterQuiescence({ presenceId: object.presenceId, state: "released" }),
	};
}

type ProcessVerdict =
	| { readonly kind: "live" }
	| { readonly kind: "gone"; readonly reason: "absent" | "birth_mismatch" | "exited" | "prior_boot" }
	| { readonly kind: "unknown"; readonly reason: RecoveryEscalationReason; readonly detail: string };

/** The recorded identity: `{"pid":..,"processStartTime":..}`, with `userSid` when it was read through the bridge. */
type RecordedProcess = ProcessRecord;

function parseRecorded(text: string): RecordedProcess | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null) return undefined;
		const pid = Reflect.get(value, "pid");
		const start = Reflect.get(value, "processStartTime");
		const sid = Reflect.get(value, "userSid");
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
		return {
			pid,
			processStartTime: typeof start === "string" ? start : null,
			userSid: typeof sid === "string" ? sid : null,
		};
	} catch {
		return undefined;
	}
}

/**
 * One attempt's observation budget (design 4.2a "Bounded unknown escalation"): the smaller of the caller's remaining
 * deadline and five seconds, measured on the prober's clock, with the deadline armed once as an event. A recorded
 * identity gets an initial observation and at most one requery inside it; a query still in flight when the deadline
 * fires is abandoned, and its late answer is never read.
 */
class ObservationBudget {
	readonly #prober: RecoveryProber;
	readonly #start: number;
	readonly #limitMs: number;
	readonly #expiry: Promise<"expired">;
	#expired = false;
	/** Observations made in this attempt, by subject. */
	readonly counts = new Map<string, number>();

	constructor(prober: RecoveryProber) {
		this.#prober = prober;
		this.#start = prober.clock.now();
		this.#limitMs = Math.min(OBSERVATION_BUDGET_MS, prober.remainingMs);
		this.#expiry = prober.clock.deadline(this.#limitMs).then(() => {
			this.#expired = true;
			return "expired" as const;
		});
	}

	get expired(): boolean {
		return this.#expired || this.#prober.clock.now() - this.#start >= this.#limitMs;
	}

	/** One observation of `pid` for `subject`, or `undefined` when the budget is spent. */
	async observe(subject: string, pid: number): Promise<ProcessObservation | undefined> {
		if (this.expired || (this.counts.get(subject) ?? 0) >= 2) return undefined;
		this.counts.set(subject, (this.counts.get(subject) ?? 0) + 1);
		const result = await Promise.race([this.#prober.observe(pid), this.#expiry]);
		return result === "expired" ? undefined : result;
	}
}

/** What a row recorded about where and when it was written, for the gate (clauses i, iii, iv) and the boot proofs. */
interface RowProvenance {
	readonly session: KernelSessionRecord;
	/** The row's directory recorded `local` when the row was written, and classifies `local` now (clause iii). */
	readonly local: boolean;
}

/**
 * A boot proven ended: the Revision 6 reboot proof names the generation's recorded session, which resolves rows whose
 * verified session equals it; the repair anchor names the session at the anchor and resolves every local row that is
 * not provably from the current boot (the restart ended every process that could have exercised that authority).
 */
type PriorBootProof = { readonly kind: "reboot" | "anchor"; readonly session: string };

/** Whether the proof covers this row: only a local row, and only one provably from the boot the proof ended. */
function fromPriorBoot(row: RowProvenance, proof: PriorBootProof | undefined, prober: RecoveryProber): boolean {
	if (proof === undefined || !row.local) return false;
	if (proof.kind === "reboot") return row.session.status === "verified" && row.session.value === proof.session;
	return !sameSession(row.session, prober.session);
}

/** A holder's provenance: its presence row's session (or the launch owner's without an object) and the store's locality. */
function holderProvenance(holder: AuthorityHolder, reservation: ReservationRow, prober: RecoveryProber): RowProvenance {
	return { session: holder.session, local: recordedLocal(reservation) && prober.storeLocalNow };
}

/**
 * Recovery-time observation of a PID another invocation recorded. The gate comes first: unless clause (iii) or (i)
 * admits it, absence, a different birth or an exit on this kernel says nothing about that row. Then the observation
 * table (`classifyObservation`): an absent PID, an exactly different creation FILETIME or a signalled process object is
 * `gone`; the same PID, creation time and SID on one handle is `live`; an unreadable or inconsistent answer (denied,
 * unreadable fields, a same-birth SID mismatch, a handle whose `GetProcessId` is not the opened PID) is requeried once
 * inside the budget and then `unknown` with that reason, a noncomparable record (no recorded identity, a record from
 * the other observation domain) is `unknown` at once. A proven prior boot (the Revision 6 proof or a repair anchor)
 * resolves an entry only after the observation could not decide it (no recorded identity, an unreadable or
 * noncomparable one): an entry whose process is observed live blocks whatever the boot evidence says, an absent one is
 * gone by observation, and an inconsistent one (a process answering the recorded birth under another SID) stays
 * unknown, since the design calls that an unresolved inconsistency and never permission to reclaim. An unchanged
 * escalated record answers its marker's own subject from the marker without a query (`cached`); every other entry is
 * queried.
 */
async function observeRecorded(
	subject: string,
	recorded: RecordedProcess | undefined,
	row: RowProvenance,
	reservation: ReservationRow,
	prober: RecoveryProber,
	proof: PriorBootProof | undefined,
	budget: ObservationBudget,
): Promise<ProcessVerdict> {
	if (!row.local && !sameSession(row.session, prober.session)) {
		const bothVerified = row.session.status === "verified" && prober.session.status === "verified";
		return {
			kind: "unknown",
			reason: bothVerified ? "owner_identity_domain_mismatch" : "owner_identity_domain_unverified",
			detail: `kernel_session_gate (${describeSession(row.session)})`,
		};
	}
	const priorBoot = fromPriorBoot(row, proof, prober);
	// The marker answers its own subject without a query; under a prior-boot proof the entry is observed instead, so
	// that a live current-boot process at that PID is seen, never resolved from a marker written before the boot.
	const cached = reservation.escalation;
	if (cached !== null && !prober.fresh && cached.subject === subject && !priorBoot) {
		return { kind: "unknown", reason: cached.reason, detail: "escalated record" };
	}
	if (recorded === undefined || recorded.pid === 0) {
		return priorBoot
			? { kind: "gone", reason: "prior_boot" }
			: { kind: "unknown", reason: "owner_identity_incomplete", detail: "no recorded identity" };
	}
	// What the last observation could not resolve; the escalated reason once the budget refuses another.
	let unresolved: { readonly reason: RecoveryEscalationReason; readonly detail: string } = {
		reason: "owner_identity_unreadable",
		detail: "observation budget spent",
	};
	// Observations made, and how many of them found the identity unreadable (as opposed to inconsistent).
	let observations = 0;
	let unreadable = 0;
	for (;;) {
		const observed = await budget.observe(subject, recorded.pid);
		if (observed === undefined) {
			// An identity that every observation made found unreadable is what the boot proof resolves; an entry the
			// deadline left unobserved is no observation at all, and an inconsistent one is no permission to reclaim:
			// both stay unknown whatever the boot evidence says.
			return priorBoot && observations > 0 && unreadable === observations
				? { kind: "gone", reason: "prior_boot" }
				: { kind: "unknown", ...unresolved };
		}
		observations++;
		const verdict = classifyObservation(recorded, observed);
		if (verdict.kind !== "unknown") return verdict;
		if (verdict.reason === "incomplete") {
			return priorBoot
				? { kind: "gone", reason: "prior_boot" }
				: { kind: "unknown", reason: "owner_identity_incomplete", detail: verdict.detail };
		}
		// Unreadable or inconsistent: the design's one fresh reopen/requery; the budget refuses a third.
		if (verdict.reason === "unreadable") unreadable++;
		unresolved = {
			reason: verdict.reason === "inconsistent" ? "owner_identity_inconsistent" : "owner_identity_unreadable",
			detail: `${verdict.detail}; observation budget spent`,
		};
	}
}

/**
 * Revision 6/7 prior-boot proof: the generation's verified kernel session differs from this verified one, and every
 * probed object passed admissibility rules 1 and 2 (it was acquired). A store with nothing to probe offers no such
 * object, so it gets no reboot proof. It applies to a store recorded and still classified `local` only: with the two
 * sessions different, `observeRecorded`'s gate admits an observation through clause (iii) alone, so a non-local or
 * flipped store's rows stay `unknown` before this proof is consulted.
 */
function priorBootProven(
	reservation: ReservationRow,
	prober: RecoveryProber,
	holders: readonly AuthorityHolder[],
	proofs: Partial<Record<AuthorityEntry, RecoveryProof>>,
): PriorBootProof | undefined {
	const recorded = reservation.presence.ownerKernelSession;
	return recorded.status === "verified" &&
		prober.session.status === "verified" &&
		recorded.value !== prober.session.value &&
		recordedLocal(reservation) &&
		prober.storeLocalNow &&
		holders.length > 0 &&
		holders.every((holder) => proofs[holder.entry] === "presence_released")
		? { kind: "reboot", session: recorded.value }
		: undefined;
}

/**
 * The repair anchor's proof (Revision 6 "Visible Repair connection action", Revision 7 "Restart only where it proves
 * something"): a user-confirmed restart recorded the verified kernel session at the fenced generation and revision; a
 * verified different session now, on a store recorded and still classified `local`, proves every process that could
 * have exercised that authority at the anchor gone. The anchor is read at the generation's current revision only, so a
 * later claim or commit discards it. A non-local store never records one.
 */
function anchorProven(reservation: ReservationRow, prober: RecoveryProber): PriorBootProof | undefined {
	const anchor = reservation.repairAnchor;
	return anchor !== null &&
		prober.session.status === "verified" &&
		prober.session.value !== anchor.kernelSession &&
		recordedLocal(reservation) &&
		prober.storeLocalNow
		? { kind: "anchor", session: anchor.kernelSession }
		: undefined;
}

/**
 * A record as found: absent (`none`), or a process. A record that names no PID names no process; one whose guard does
 * not parse still names its PID, unguarded. A record that exists but cannot be read is incomplete discovery: it stays in
 * the census with an unreadable identity, which is unknown.
 */
async function readRecord(path: string): Promise<RecordedProcess | "none"> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
		return { pid: 0, processStartTime: null };
	}
	return parseRecorded(text) ?? { pid: 0, processStartTime: null };
}

type CensusEntry = {
	readonly name: string;
	readonly recorded: RecordedProcess;
	/** The provenance the row's launch recorded beside it, or nothing (a legacy or foreign writer). */
	readonly provenance: RowProvenance | undefined;
};

/** A row's provenance from its generation directory's launch record, with clause (iii) applied to that directory. */
async function directoryProvenance(
	paths: HostDaemonDirectory,
	instanceId: string,
	prober: RecoveryProber,
): Promise<RowProvenance | "unreadable" | undefined> {
	// A claim file is untrusted input: an instance id that is not a plain directory name names no generation.
	if (instanceId === "" || instanceId === "." || instanceId === ".." || /[\\/]/.test(instanceId)) return undefined;
	const record = await readLaunchProvenanceRecord(generationPaths(paths, instanceId).launchProvenanceFile);
	if (record.status === "unreadable") return "unreadable";
	if (record.status === "none") return undefined;
	return {
		session: record.provenance.kernelSession,
		local: record.provenance.directoryLocal && prober.daemonDirectoryLocalNow,
	};
}

type CensusResult =
	| { readonly verdict: "gone" }
	| { readonly verdict: "live"; readonly detail: string }
	| {
			readonly verdict: "unknown";
			readonly detail: string;
			readonly reason: RecoveryEscalationReason;
			/** The census entry that stayed unknown; the escalation marker's subject. */
			readonly subject: string;
	  };

/**
 * The listener/session/descendant census (design 4.2a, "All existing full-census predicates remain"): every recorded
 * generation supervisor and host child of this endpoint and every session-path claim. A row whose identity is one of
 * the generation's recorded authorities is that actor's own entry, discharged by the actor's proof; every other row is
 * observed exactly through the gate with the provenance its launch recorded beside it (none: unknown). A directory or
 * record that cannot be read is incomplete discovery, which is unknown.
 */
async function census(
	paths: HostDaemonDirectory,
	reservation: ReservationRow,
	roles: readonly RoleRow[],
	prober: RecoveryProber,
	proof: PriorBootProof | undefined,
	budget: ObservationBudget,
): Promise<CensusResult> {
	const incomplete = (subject: string, detail: string): CensusResult => ({
		verdict: "unknown",
		reason: "owner_identity_unreadable",
		subject,
		detail: `census incomplete: ${detail}`,
	});
	const provenances = new Map<string, RowProvenance | "unreadable" | undefined>();
	const provenanceOf = async (instanceId: string) => {
		if (!provenances.has(instanceId))
			provenances.set(instanceId, await directoryProvenance(paths, instanceId, prober));
		return provenances.get(instanceId);
	};
	const entries: CensusEntry[] = [];
	let instanceIds: string[];
	try {
		instanceIds = await readdir(paths.generationsDir);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return incomplete("generations", `generations directory unreadable (${(error as Error).message})`);
		}
		instanceIds = [];
	}
	for (const instanceId of instanceIds) {
		const generation = generationPaths(paths, instanceId);
		const provenance = await provenanceOf(instanceId);
		if (provenance === "unreadable") {
			return incomplete(`generation ${instanceId}`, `generation ${instanceId} provenance unreadable`);
		}
		const supervisor = await readRecord(generation.pidFile);
		if (supervisor !== "none") {
			entries.push({ name: `generation ${instanceId} supervisor`, recorded: supervisor, provenance });
		}
		const child = await readRecord(generation.childPidFile);
		if (child !== "none") entries.push({ name: `generation ${instanceId} host child`, recorded: child, provenance });
	}
	const claims = await readSessionPathClaimsCompletely(paths.reservationsDir);
	if (claims.unreadable.length > 0) return incomplete("claims", `unreadable ${claims.unreadable.join(", ")}`);
	for (const claim of claims.claims) {
		const provenance = await provenanceOf(claim.owner.instanceId);
		if (provenance === "unreadable") {
			return incomplete(
				`generation ${claim.owner.instanceId}`,
				`generation ${claim.owner.instanceId} provenance unreadable`,
			);
		}
		entries.push({
			name: `session claim of generation ${claim.owner.instanceId}`,
			recorded: claim.owner,
			provenance,
		});
	}
	// The generation's own actors: a row naming one of them is that actor's entry, which its proof discharges. Step (4)
	// proved every holder of the probe set; the fence discharged every role that never reached `granted`.
	const authorities = new Set<string>([
		reservation.owner,
		...roles.flatMap((row) => (row.participant ? [row.participant] : [])),
	]);
	for (const { name, recorded, provenance } of entries) {
		// The store's key is the canonical record JSON (`processRecordKey`): with its SID for a row the bridge wrote.
		if (recorded.pid !== 0 && authorities.has(processRecordKey(recorded))) continue;
		if (provenance === undefined) {
			return {
				verdict: "unknown",
				reason: "owner_identity_domain_unverified",
				subject: name,
				detail: `${name} (pid ${recorded.pid}) is unknown: no recorded provenance`,
			};
		}
		const verdict = await observeRecorded(name, recorded, provenance, reservation, prober, proof, budget);
		if (verdict.kind === "live") return { verdict: "live", detail: `${name} (pid ${recorded.pid}) is live` };
		if (verdict.kind === "unknown") {
			return {
				verdict: "unknown",
				reason: verdict.reason,
				subject: name,
				detail: `${name} (pid ${recorded.pid}) is unknown: ${verdict.detail}`,
			};
		}
	}
	return { verdict: "gone" };
}

function describeHolder(holder: AuthorityHolder): string {
	const recorded = parseRecorded(holder.identity);
	const host = holder.presence.status === "predeclared" ? `, host ${holder.presence.hostLabel}` : "";
	return `${holder.entry} (pid ${recorded?.pid ?? "unrecorded"}${host}, ${describeSession(holder.session)})`;
}

function holderOf(holder: AuthorityHolder | undefined, reservation: ReservationRow): RecoveryHolder {
	const session = holder?.session ?? reservation.presence.ownerKernelSession;
	return {
		entry: holder?.entry ?? "census",
		hostLabel: holder?.presence.status === "predeclared" ? holder.presence.hostLabel : "",
		kernelSession: session.status === "verified" ? session.value : null,
	};
}

/**
 * The Repair action a refusal calls for (design 4.2a "Visible Repair connection action", Revision 7 "Repair
 * amendments"): a held object is waited for; a live process is drained through its own authorized stop; an unknowable
 * identity gets the restart only on a local-store endpoint whose rows have same-kernel provenance (recorded `local`
 * and `local` now), and the recorded host otherwise; a denied presence store names the access to restore first.
 */
function actionFor(
	reason: RecoveryRefusal,
	reservation: ReservationRow,
	prober: RecoveryProber,
	storeDenied: boolean,
): RecoveryAction {
	switch (reason) {
		case "presence_occupied":
			return "wait_for_owner";
		case "authority_live":
		case "census_live":
			return "drain_owner";
		case "revision_changed":
			return "retry";
		default:
			if (storeDenied) return "restore_store_access";
			return recordedLocal(reservation) && prober.storeLocalNow ? "restart_computer" : "resolve_on_recorded_host";
	}
}

async function recoverGeneration(
	store: EndpointReservationStore,
	generation: string,
	paths: HostDaemonDirectory,
	prober: RecoveryProber,
	budget: ObservationBudget,
): Promise<RecoveryOutcome | undefined> {
	// (2) The durable fence: a successful claim either committed before it, and is in the history, or fails after it.
	if (store.reservation(generation).state !== "cancelling") store.cancel(generation);
	const fenced = store.reservation(generation);
	const refused = (
		reason: RecoveryRefusal,
		detail: string,
		extra: {
			readonly holder?: AuthorityHolder;
			readonly occupied?: PresenceObjectRecord;
			readonly unknown?: { readonly subject: string; readonly reason: RecoveryEscalationReason };
			readonly storeDenied?: boolean;
			/** The revision the refused evidence was read at (step 4's revalidated revision for the census). */
			readonly readRevision?: number;
		} = {},
	): RecoveryOutcome => {
		let escalation: RecoveryEscalation | undefined;
		if (extra.unknown) {
			const observations = budget.counts.get(extra.unknown.subject) ?? 0;
			const cached =
				observations === 0 &&
				fenced.escalation !== null &&
				fenced.escalation.subject === extra.unknown.subject &&
				!prober.fresh;
			// The durable escalated reason, at the revision this attempt read: a record that changed since (a transition
			// committed meanwhile) gets no marker, so the next attempt's budget is fresh.
			if (!cached) {
				try {
					store.escalate(
						generation,
						{ subject: extra.unknown.subject, reason: extra.unknown.reason, observations },
						extra.readRevision ?? fenced.revision,
					);
				} catch (error: unknown) {
					if (!(error instanceof EndpointReservationError && error.reason === "revision_changed")) throw error;
				}
			}
			escalation = { reason: extra.unknown.reason, observations, cached };
		} else if (
			fenced.escalation !== null &&
			prober.fresh &&
			(reason === "authority_live" || reason === "census_live")
		) {
			// The explicit assessment resolved what was escalated: the record is no longer escalated, only blocked.
			store.clearEscalation(generation);
		}
		return {
			status: "refused",
			reason,
			generation,
			detail,
			action: actionFor(reason, fenced, prober, extra.storeDenied === true),
			holder: holderOf(extra.holder, fenced),
			...(escalation && { escalation }),
			...(extra.occupied && { occupied: extra.occupied }),
		};
	};
	const held = new Map<AuthorityEntry, () => void>();
	const proofs: Partial<Record<AuthorityEntry, RecoveryProof>> = {};
	/** The retired generation's objects, deleted once the recovered guards are released. */
	let retiredObjects: readonly PresenceObjectRecord[] | undefined;
	const anchored = anchorProven(fenced, prober);
	try {
		// (3) Nonblocking acquisitions in presence-ID order, outside every transaction.
		for (const holder of probeSet(fenced, store.roleRows(generation))) {
			const acquisition = acquire(holder.presence, fenced, prober);
			if (acquisition.kind === "acquired") {
				held.set(holder.entry, acquisition.release);
				proofs[holder.entry] = "presence_released";
				continue;
			}
			if (acquisition.kind === "occupied") {
				return refused("presence_occupied", `${describeHolder(holder)}: its presence object is held`, {
					holder,
					...(holder.presence.status === "predeclared" && { occupied: holder.presence }),
				});
			}
			// Not-found: the holder's clean exit may have committed `released` and deleted the object after the fenced read.
			// Reread the row; a `released` entry is discharged by that commit and step (4) drops it from the probe set.
			if (acquisition.notFound && releasedMeanwhile(store, generation, holder.entry)) continue;
			const verdict = await observeRecorded(
				holder.entry,
				parseRecorded(holder.identity),
				holderProvenance(holder, fenced, prober),
				fenced,
				prober,
				anchored,
				budget,
			);
			if (verdict.kind === "gone") {
				proofs[holder.entry] = "process_gone";
				continue;
			}
			const why = `presence ${acquisition.reason}; process ${verdict.kind === "live" ? "live" : verdict.detail}`;
			if (verdict.kind === "live") {
				return refused("authority_live", `${describeHolder(holder)}: ${why}`, { holder });
			}
			return refused("authority_unknown", `${describeHolder(holder)}: ${why}`, {
				holder,
				unknown: { subject: holder.entry, reason: verdict.reason },
				storeDenied: acquisition.accessDenied,
			});
		}
		// (4) Revalidate at the current revision: what committed `released` meanwhile is discharged by that commit.
		const current = store.reservation(generation);
		if (current.state !== "cancelling") return refused("revision_changed", `state ${current.state}`);
		const holders = probeSet(current, store.roleRows(generation));
		for (const entry of Object.keys(proofs) as AuthorityEntry[]) {
			if (holders.some((holder) => holder.entry === entry)) continue;
			held.get(entry)?.();
			held.delete(entry);
			delete proofs[entry];
		}
		const unproven = holders.find((holder) => proofs[holder.entry] === undefined);
		if (unproven) return refused("revision_changed", `${describeHolder(unproven)} appeared after the probe`);
		// (5) The full census, then retirement at the revalidated revision while the recovered guards are held.
		const result = await census(
			paths,
			current,
			store.roleRows(generation),
			prober,
			anchored ?? priorBootProven(current, prober, holders, proofs),
			budget,
		);
		if (result.verdict === "live") return refused("census_live", result.detail);
		if (result.verdict === "unknown") {
			return refused("census_unknown", result.detail, {
				unknown: { subject: result.subject, reason: result.reason },
				readRevision: current.revision,
			});
		}
		try {
			store.retire(generation, current.revision, proofs);
		} catch (error: unknown) {
			if (error instanceof EndpointReservationError && error.reason === "revision_changed") {
				return refused("revision_changed", "the generation changed during the census");
			}
			throw error;
		}
		retiredObjects = [current.ownerPresence, ...store.roleRows(generation).map((row) => row.presence)];
		return undefined;
	} finally {
		for (const release of held.values()) release();
		// At retirement (Revision 7): the tombstone is kept; the objects are deleted by exclusive open after the guards
		// are released. One another handle still holds is left for the sweep.
		for (const object of retiredObjects ?? []) deletePresenceObject(object, prober.native);
	}
}

/** Rereads one entry of `generation` after a not-found probe: discharged by its own `released` commit, or not. */
function releasedMeanwhile(store: EndpointReservationStore, generation: string, entry: AuthorityEntry): boolean {
	const reservation = store.reservation(generation);
	if (entry === "owner") return reservation.ownerStatus === "released";
	return store.roleRow({ endpoint: reservation.endpoint, generation, role: entry })?.status === "released";
}

/**
 * Recovers every generation of `endpoint` that is not retired, oldest first, so exactly one successor can then be
 * reserved. The caller holds the endpoint lock. The first generation that cannot be resolved ends recovery refused,
 * with its fence kept and nothing retired, mutated or signalled. A guard the prober holds (`held`) leaves with the
 * attempt: after the retirement commit, or at once when the attempt cannot retire or no entry names its object.
 */
export async function recoverEndpointReservations(
	store: EndpointReservationStore,
	endpoint: string,
	paths: HostDaemonDirectory,
	prober: RecoveryProber,
): Promise<RecoveryOutcome> {
	const recovered: string[] = [];
	const budget = new ObservationBudget(prober);
	try {
		for (const generation of store.activeGenerations(endpoint)) {
			const outcome = await recoverGeneration(store, generation, paths, prober, budget);
			if (outcome) return outcome;
			recovered.push(generation);
		}
		return { status: "recovered", generations: recovered };
	} finally {
		prober.held?.release();
	}
}
