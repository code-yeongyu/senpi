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
 * A FILETIME is compared exactly, as a decimal integer string, never through milliseconds or a tolerance. Nothing here
 * mutates the credential, signals a process, deletes a record or a presence object, or waits for a lock.
 */
import { readdir, readFile } from "node:fs/promises";
import { type ProcessIdentityResult, readProcessIdentity } from "../../utils/process-identity.ts";
import {
	type AuthorityEntry,
	EndpointReservationError,
	type EndpointReservationStore,
	type KernelSessionRecord,
	type PresenceObjectRecord,
	type RecoveryProof,
	type ReservationRow,
	type RoleRow,
} from "./endpoint-reservation-store.ts";
import { generationPaths, type HostDaemonDirectory } from "./host-daemon-paths.ts";
import type { ReservationRecoveryRefusal } from "./host-decision.ts";
import { readSessionPathClaims } from "./host-reservations.ts";
import { kernelSession } from "./presence-placement.ts";
import type { PresencePlacementLoad } from "./socket-secret-native.ts";

/** What recovery could not resolve; each is a typed refusal, never a deadline or a guess. */
export type RecoveryRefusal = ReservationRecoveryRefusal["reason"];

export type RecoveryOutcome =
	| { readonly status: "recovered"; readonly generations: readonly string[] }
	| {
			readonly status: "refused";
			readonly reason: RecoveryRefusal;
			readonly generation: string;
			readonly detail: string;
	  };

/** The probing invocation's own view: its bridge, its kernel session and how the store directory classifies now. */
export interface RecoveryProber {
	readonly native: PresencePlacementLoad;
	readonly session: KernelSessionRecord;
	readonly storeLocalNow: boolean;
	readonly observe: (pid: number) => Promise<ProcessIdentityResult>;
}

/** One reopen of a recorded PID through the OS, bounded like the design's per-observation budget. */
const OBSERVE_TIMEOUT_MS = 5_000;

function observeProcess(pid: number): Promise<ProcessIdentityResult> {
	return readProcessIdentity(pid, process.platform, OBSERVE_TIMEOUT_MS);
}

/** Reads this invocation's kernel session and classifies the store directory from its opened handle, once. */
export function recoveryProber(
	storeDirectory: string,
	native: PresencePlacementLoad,
	observe: (pid: number) => Promise<ProcessIdentityResult> = observeProcess,
): RecoveryProber {
	if (native.status !== "available") {
		return { native, session: { status: "unverified", reason: native.reason }, storeLocalNow: false, observe };
	}
	return {
		native,
		session: kernelSession(native.native.kernelSessionIdentity()),
		storeLocalNow: native.native.classifyVolume(storeDirectory).locality === "local",
		observe,
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
	| { readonly kind: "unknown"; readonly reason: string };

/**
 * One nonblocking acquisition of a recorded object. The bridge keeps the guard only when it is admissible: rule 1 (tag
 * and physical identity), rule 2 (recorded `local`, and the object's own handle `local` now) and, for a relocated
 * object, rule 3 (the row's and this kernel's sessions verified and equal). Anything else it releases at once.
 */
function acquire(object: PresenceObjectRecord, reservation: ReservationRow, prober: RecoveryProber): Acquisition {
	if (object.status !== "predeclared") return { kind: "unknown", reason: "presence_unavailable" };
	if (prober.native.status !== "available") return { kind: "unknown", reason: prober.native.reason };
	const bridge = prober.native.native;
	const relocated =
		reservation.presence.root.status === "placed" && reservation.presence.root.placement === "relocated";
	const result = bridge.presenceProbe({
		presenceId: object.presenceId,
		path: object.path,
		header: Buffer.from(object.header, "hex"),
		volumeSerial: object.volumeSerial,
		fileId: object.fileId,
		createdLocal: object.classification === "local",
		relocated,
		kernelSession: object.kernelSession.status === "verified" ? object.kernelSession.value : null,
	});
	if (result.status === "occupied") return { kind: "occupied" };
	if (result.status !== "acquired") {
		return { kind: "unknown", reason: "reason" in result ? `${result.status}:${result.reason}` : result.status };
	}
	return {
		kind: "acquired",
		// The retirement commit is this guard's quiescence receipt; it is closed only after it, or when the attempt ends.
		release: () => bridge.presenceReleaseAfterQuiescence({ presenceId: object.presenceId, state: "released" }),
	};
}

type ProcessVerdict =
	| { readonly kind: "live" }
	| { readonly kind: "gone"; readonly reason: "absent" | "birth_mismatch" | "prior_boot" }
	| { readonly kind: "unknown"; readonly reason: string };

interface RecordedProcess {
	readonly pid: number;
	readonly processStartTime: string | null;
}

function parseRecorded(text: string): RecordedProcess | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null) return undefined;
		const pid = Reflect.get(value, "pid");
		const start = Reflect.get(value, "processStartTime");
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
		return { pid, processStartTime: typeof start === "string" ? start : null };
	} catch {
		return undefined;
	}
}

/**
 * Recovery-time observation of a PID another invocation recorded. The gate comes first: unless clause (iii) or (i)
 * admits it, absence, a different birth or an exit on this kernel says nothing about that row. Then only an absent PID or
 * an exactly different creation FILETIME is `gone`; equal is `live`; an unreadable or noncomparable identity is
 * `unknown`, except that a proven prior boot ends every process of that boot.
 */
async function observeRecorded(
	recorded: RecordedProcess | undefined,
	rowSession: KernelSessionRecord,
	reservation: ReservationRow,
	prober: RecoveryProber,
	priorBoot: boolean,
): Promise<ProcessVerdict> {
	const clauseIII = recordedLocal(reservation) && prober.storeLocalNow;
	if (!clauseIII && !sameSession(rowSession, prober.session)) {
		return { kind: "unknown", reason: `kernel_session_gate (${describeSession(rowSession)})` };
	}
	if (recorded === undefined || recorded.pid === 0) return { kind: "unknown", reason: "identity_unreadable" };
	const observed = await prober.observe(recorded.pid);
	if (observed.kind === "absent") return { kind: "gone", reason: "absent" };
	if (observed.kind === "error") {
		return priorBoot ? { kind: "gone", reason: "prior_boot" } : { kind: "unknown", reason: "identity_unreadable" };
	}
	const start = recorded.processStartTime;
	if (start === null || !/^\d+$/.test(start) || !/^\d+$/.test(observed.identity)) {
		return priorBoot ? { kind: "gone", reason: "prior_boot" } : { kind: "unknown", reason: "identity_incomplete" };
	}
	return BigInt(start) === BigInt(observed.identity) ? { kind: "live" } : { kind: "gone", reason: "birth_mismatch" };
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
): boolean {
	const recorded = reservation.presence.ownerKernelSession;
	return (
		recorded.status === "verified" &&
		prober.session.status === "verified" &&
		recorded.value !== prober.session.value &&
		holders.length > 0 &&
		holders.every((holder) => proofs[holder.entry] === "presence_released")
	);
}

async function readRecord(path: string): Promise<RecordedProcess | "none"> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return "none";
	}
	// A record that names no PID names no process; one whose guard does not parse still names its PID, unguarded. A record
	// that cannot be read at all is not proof of anything, so it stays in the census with an unreadable identity.
	return parseRecorded(text) ?? { pid: 0, processStartTime: null };
}

/**
 * The listener/session/descendant census (design 4.2a, "All existing full-census predicates remain"): every recorded
 * generation supervisor and host child of this endpoint and every session-path claim, each observed exactly through the
 * gate. Their rows were written by the generation's launch, so they carry its owner's kernel session.
 */
async function census(
	paths: HostDaemonDirectory,
	reservation: ReservationRow,
	prober: RecoveryProber,
	priorBoot: boolean,
): Promise<{ readonly verdict: "gone" } | { readonly verdict: "live" | "unknown"; readonly detail: string }> {
	const entries: { readonly name: string; readonly recorded: RecordedProcess }[] = [];
	for (const instanceId of await readdir(paths.generationsDir).catch(() => [] as string[])) {
		const generation = generationPaths(paths, instanceId);
		const supervisor = await readRecord(generation.pidFile);
		if (supervisor !== "none") entries.push({ name: `generation ${instanceId} supervisor`, recorded: supervisor });
		const child = await readRecord(generation.childPidFile);
		if (child !== "none") entries.push({ name: `generation ${instanceId} host child`, recorded: child });
	}
	for (const claim of await readSessionPathClaims(paths.reservationsDir)) {
		entries.push({ name: `session claim of generation ${claim.owner.instanceId}`, recorded: claim.owner });
	}
	const session = reservation.presence.ownerKernelSession;
	for (const { name, recorded } of entries) {
		const verdict = await observeRecorded(recorded, session, reservation, prober, priorBoot);
		if (verdict.kind === "live") return { verdict: "live", detail: `${name} (pid ${recorded.pid}) is live` };
		if (verdict.kind === "unknown") {
			return { verdict: "unknown", detail: `${name} (pid ${recorded.pid}) is unknown: ${verdict.reason}` };
		}
	}
	return { verdict: "gone" };
}

function describeHolder(holder: AuthorityHolder): string {
	const recorded = parseRecorded(holder.identity);
	const host = holder.presence.status === "predeclared" ? `, host ${holder.presence.hostLabel}` : "";
	return `${holder.entry} (pid ${recorded?.pid ?? "unrecorded"}${host}, ${describeSession(holder.session)})`;
}

async function recoverGeneration(
	store: EndpointReservationStore,
	generation: string,
	paths: HostDaemonDirectory,
	prober: RecoveryProber,
): Promise<RecoveryOutcome | undefined> {
	const refused = (reason: RecoveryRefusal, detail: string): RecoveryOutcome => ({
		status: "refused",
		reason,
		generation,
		detail,
	});
	// (2) The durable fence: a successful claim either committed before it, and is in the history, or fails after it.
	if (store.reservation(generation).state !== "cancelling") store.cancel(generation);
	const fenced = store.reservation(generation);
	const held = new Map<AuthorityEntry, () => void>();
	const proofs: Partial<Record<AuthorityEntry, RecoveryProof>> = {};
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
				return refused("presence_occupied", `${describeHolder(holder)}: its presence object is held`);
			}
			const verdict = await observeRecorded(parseRecorded(holder.identity), holder.session, fenced, prober, false);
			if (verdict.kind === "gone") {
				proofs[holder.entry] = "process_gone";
				continue;
			}
			const why = `presence ${acquisition.reason}; process ${verdict.kind === "live" ? "live" : verdict.reason}`;
			return refused(
				verdict.kind === "live" ? "authority_live" : "authority_unknown",
				`${describeHolder(holder)}: ${why}`,
			);
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
		const result = await census(paths, current, prober, priorBootProven(current, prober, holders, proofs));
		if (result.verdict !== "gone") {
			return refused(result.verdict === "live" ? "census_live" : "census_unknown", result.detail);
		}
		try {
			store.retire(generation, current.revision, proofs);
		} catch (error: unknown) {
			if (error instanceof EndpointReservationError && error.reason === "revision_changed") {
				return refused("revision_changed", "the generation changed during the census");
			}
			throw error;
		}
		return undefined;
	} finally {
		for (const release of held.values()) release();
	}
}

/**
 * Recovers every generation of `endpoint` that is not retired, oldest first, so exactly one successor can then be
 * reserved. The caller holds the endpoint lock. The first generation that cannot be resolved ends recovery refused,
 * with its fence kept and nothing retired, mutated or signalled.
 */
export async function recoverEndpointReservations(
	store: EndpointReservationStore,
	endpoint: string,
	paths: HostDaemonDirectory,
	prober: RecoveryProber,
): Promise<RecoveryOutcome> {
	const recovered: string[] = [];
	for (const generation of store.activeGenerations(endpoint)) {
		const outcome = await recoverGeneration(store, generation, paths, prober);
		if (outcome) return outcome;
		recovered.push(generation);
	}
	return { status: "recovered", generations: recovered };
}
