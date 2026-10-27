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
 * A census row (a generation pidfile, a host-child pidfile, a session claim) carries only the provenance its own launch
 * recorded beside it (launch-provenance.ts: the owner's kernel session and the daemon directory's classification at the
 * write), never the reservation store's locality or the owner's session by default; a row with no provenance stays
 * unknown. A row whose identity is a recorded authority of the generation is that actor's own entry and is discharged
 * by that actor's proof (its `released` commit, an admissible acquisition or the exact process proof), so a quiescent
 * actor that stays alive doing unrelated work does not block. Incomplete discovery (a directory or record that cannot
 * be read) is unknown, never nothing to find. The prior-boot proof resolves only entries provably from that boot: a
 * verified session equal to the one proven ended, on a directory recorded and still classified `local`.
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
import { readSessionPathClaimsCompletely } from "./host-reservations.ts";
import { readLaunchProvenanceRecord } from "./launch-provenance.ts";
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

/**
 * The probing invocation's own view: its bridge, its kernel session, how the store directory classifies now, and how
 * the endpoint's daemon directory (where the census rows live) classifies now.
 */
export interface RecoveryProber {
	readonly native: PresencePlacementLoad;
	readonly session: KernelSessionRecord;
	readonly storeLocalNow: boolean;
	readonly daemonDirectoryLocalNow: boolean;
	readonly observe: (pid: number) => Promise<ProcessIdentityResult>;
}

/** One reopen of a recorded PID through the OS, bounded like the design's per-observation budget. */
const OBSERVE_TIMEOUT_MS = 5_000;

function observeProcess(pid: number): Promise<ProcessIdentityResult> {
	return readProcessIdentity(pid, process.platform, OBSERVE_TIMEOUT_MS);
}

/**
 * Reads this invocation's kernel session and classifies the store directory and the daemon directory from their opened
 * handles, once. Without a daemon directory its rows get no clause (iii).
 */
export function recoveryProber(
	storeDirectory: string,
	native: PresencePlacementLoad,
	observe: (pid: number) => Promise<ProcessIdentityResult> = observeProcess,
	daemonDirectory?: string,
): RecoveryProber {
	if (native.status !== "available") {
		return {
			native,
			session: { status: "unverified", reason: native.reason },
			storeLocalNow: false,
			daemonDirectoryLocalNow: false,
			observe,
		};
	}
	const local = (directory: string) => native.native.classifyVolume(directory).locality === "local";
	return {
		native,
		session: kernelSession(native.native.kernelSessionIdentity()),
		storeLocalNow: local(storeDirectory),
		daemonDirectoryLocalNow: daemonDirectory !== undefined && local(daemonDirectory),
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

/** What a row recorded about where and when it was written, for the gate (clauses i, iii, iv) and the reboot proof. */
interface RowProvenance {
	readonly session: KernelSessionRecord;
	/** The row's directory recorded `local` when the row was written, and classifies `local` now (clause iii). */
	readonly local: boolean;
}

/**
 * Whether the prior-boot proof resolves this row (Revision 6/7 "Reboot proof", scoped per entry): the row is from the
 * boot proven ended (its verified session equals that session) and lives on a directory recorded and still `local`.
 * A current-boot row, an unverified session (clause iv) or a non-local directory gets no proof from the reboot.
 */
function fromPriorBoot(row: RowProvenance, priorBootSession: string | undefined): boolean {
	return (
		priorBootSession !== undefined &&
		row.local &&
		row.session.status === "verified" &&
		row.session.value === priorBootSession
	);
}

/**
 * Recovery-time observation of a PID another invocation recorded. The gate comes first: unless clause (iii) or (i)
 * admits it, absence, a different birth or an exit on this kernel says nothing about that row. Then only an absent PID or
 * an exactly different creation FILETIME is `gone`; equal is `live`; an unreadable or noncomparable identity is
 * `unknown`, except that a proven prior boot ends every process provably of that boot (`fromPriorBoot`).
 */
async function observeRecorded(
	recorded: RecordedProcess | undefined,
	row: RowProvenance,
	prober: RecoveryProber,
	priorBootSession: string | undefined,
): Promise<ProcessVerdict> {
	if (!row.local && !sameSession(row.session, prober.session)) {
		return { kind: "unknown", reason: `kernel_session_gate (${describeSession(row.session)})` };
	}
	const priorBoot = fromPriorBoot(row, priorBootSession);
	if (recorded === undefined || recorded.pid === 0) {
		return priorBoot ? { kind: "gone", reason: "prior_boot" } : { kind: "unknown", reason: "identity_unreadable" };
	}
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

/** A holder's provenance: its presence row's session (or the launch owner's without an object) and the store's locality. */
function holderProvenance(holder: AuthorityHolder, reservation: ReservationRow, prober: RecoveryProber): RowProvenance {
	return { session: holder.session, local: recordedLocal(reservation) && prober.storeLocalNow };
}

/**
 * Revision 6/7 prior-boot proof: the generation's verified kernel session differs from this verified one, every probed
 * object passed admissibility rules 1 and 2 (it was acquired), and the store is recorded and still classified `local`.
 * A store with nothing to probe offers no such object, so it gets no reboot proof. The proof names the session proven
 * ended; it resolves only entries provably from that session (`fromPriorBoot`), never other-host or current-boot ones.
 */
function priorBootProven(
	reservation: ReservationRow,
	prober: RecoveryProber,
	holders: readonly AuthorityHolder[],
	proofs: Partial<Record<AuthorityEntry, RecoveryProof>>,
): string | undefined {
	const recorded = reservation.presence.ownerKernelSession;
	return recorded.status === "verified" &&
		prober.session.status === "verified" &&
		recorded.value !== prober.session.value &&
		recordedLocal(reservation) &&
		prober.storeLocalNow &&
		holders.length > 0 &&
		holders.every((holder) => proofs[holder.entry] === "presence_released")
		? recorded.value
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
	priorBootSession: string | undefined,
): Promise<{ readonly verdict: "gone" } | { readonly verdict: "live" | "unknown"; readonly detail: string }> {
	const unknown = (detail: string) => ({ verdict: "unknown" as const, detail });
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
			return unknown(`census incomplete: generations directory unreadable (${(error as Error).message})`);
		}
		instanceIds = [];
	}
	for (const instanceId of instanceIds) {
		const generation = generationPaths(paths, instanceId);
		const provenance = await provenanceOf(instanceId);
		if (provenance === "unreadable")
			return unknown(`census incomplete: generation ${instanceId} provenance unreadable`);
		const supervisor = await readRecord(generation.pidFile);
		if (supervisor !== "none") {
			entries.push({ name: `generation ${instanceId} supervisor`, recorded: supervisor, provenance });
		}
		const child = await readRecord(generation.childPidFile);
		if (child !== "none") entries.push({ name: `generation ${instanceId} host child`, recorded: child, provenance });
	}
	const claims = await readSessionPathClaimsCompletely(paths.reservationsDir);
	if (claims.unreadable.length > 0) return unknown(`census incomplete: unreadable ${claims.unreadable.join(", ")}`);
	for (const claim of claims.claims) {
		const provenance = await provenanceOf(claim.owner.instanceId);
		if (provenance === "unreadable") {
			return unknown(`census incomplete: generation ${claim.owner.instanceId} provenance unreadable`);
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
		if (recorded.pid !== 0 && authorities.has(identityKeyOf(recorded))) continue;
		if (provenance === undefined) return unknown(`${name} (pid ${recorded.pid}) is unknown: no recorded provenance`);
		const verdict = await observeRecorded(recorded, provenance, prober, priorBootSession);
		if (verdict.kind === "live") return { verdict: "live", detail: `${name} (pid ${recorded.pid}) is live` };
		if (verdict.kind === "unknown") return unknown(`${name} (pid ${recorded.pid}) is unknown: ${verdict.reason}`);
	}
	return { verdict: "gone" };
}

/** The canonical identity key the store records (`{"pid":..,"processStartTime":..}`), for an exact match. */
function identityKeyOf(recorded: RecordedProcess): string {
	return JSON.stringify({ pid: recorded.pid, processStartTime: recorded.processStartTime });
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
			const verdict = await observeRecorded(
				parseRecorded(holder.identity),
				holderProvenance(holder, fenced, prober),
				prober,
				undefined,
			);
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
		const result = await census(
			paths,
			current,
			store.roleRows(generation),
			prober,
			priorBootProven(current, prober, holders, proofs),
		);
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
