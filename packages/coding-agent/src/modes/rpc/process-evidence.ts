/**
 * Process evidence for the reservation paths (sisyphuslabs/omo-desktop-app#4199, design 4.2a "OS identity", Revision 3/4
 * identity paragraphs, Revision 8 "Process evidence and the kernel-session gate"). On Windows, through the bridge, a
 * process is identified by `OpenProcess` + `GetProcessId` + the complete creation FILETIME + the `TokenUser` SID read on
 * ONE handle; everywhere else by its PID and the platform's start-time discriminator, as before. This module decides
 * what an observation says about a recorded identity (the design's observation table) and nothing else: the
 * kernel-session gate, the budget and the grant transaction are the callers'.
 *
 * "A readable different creation time proves the recorded instance gone even if the replacement is still live under the
 * same SID. Reject its stale claim/grant and never signal or adopt the replacement. A matching creation time with
 * unexpected SID, access denial, unreadable fields or inconsistent handle/PID is unknown." An account mismatch with the
 * same birth identity "is an unresolved inconsistency, not permission to reclaim."
 *
 * Two observation domains, never compared against each other. A record that carries a `userSid` was read on a process
 * handle (`GetProcessTimes`, the complete FILETIME); one without was read by the platform's start-time reader, on Windows
 * the CIM table, whose `CreationDate` keeps microseconds only and so differs from the handle's FILETIME in its last digit.
 * A gone verdict from a different creation time needs a "verified common observation domain", so a handle observation of
 * a SID-less record and a reader observation of a SID-bearing record are both `incomplete`: the old two-field rows stay
 * readable and stay unknown, and a daemon record written through the bridge (`bridgeProcessIdentity`) reads live or
 * gone exactly. Because the SID is the marker, a handle read that answered its FILETIME but not its SID is never
 * written as a two-field record: that row would read as the reader's and a later reader would compare across domains.
 */
import { randomUUID } from "node:crypto";
import { type ProcessIdentityResult, readProcessIdentity, readProcessStartTime } from "../../utils/process-identity.ts";
import type { NativeProcessBinding, NativeProcessObservation, PresencePlacementLoad } from "./socket-secret-native.ts";

/** What one process handle answered; each field `null` when its query failed. */
export interface ProcessFacts {
	readonly handlePid: number | null;
	/** The complete creation FILETIME as a decimal string. */
	readonly creationTime: string | null;
	readonly userSid: string | null;
	/** Whether the process object is signalled. */
	readonly exited: boolean | null;
}

/**
 * One observation of a PID: the start-time reader's answer (`present` with the platform's discriminator, `absent`,
 * `error`) or the bridge's facts read on an opened handle (`opened`). A denied or failed open is `error`; a PID no
 * process has is `absent`.
 */
export type ProcessObservation = ProcessIdentityResult | { readonly kind: "opened"; readonly facts: ProcessFacts };

/** A recorded process: PID, its exact start discriminator and, on Windows through the bridge, its `TokenUser` SID. */
export interface ProcessRecord {
	readonly pid: number;
	readonly processStartTime: string | null;
	readonly userSid?: string | null;
}

/**
 * The canonical JSON of a recorded identity, the key the reservation store records for an owner or a participant and
 * the recovery census matches daemon records against: exact on PID, start discriminator and, when recorded, SID; an
 * identity without a SID keeps the two-field encoding every earlier row has.
 */
export function processRecordKey(record: ProcessRecord): string {
	const { pid, processStartTime } = record;
	return JSON.stringify(
		typeof record.userSid === "string"
			? { pid, processStartTime, userSid: record.userSid }
			: { pid, processStartTime },
	);
}

/**
 * What an observation says about the recorded instance. `unknown` names the design's escalation reason: `unreadable`
 * (denied or failed open, an unreadable field, `GetProcessId` included) is requeried once by the caller's budget,
 * `inconsistent` (same birth, another SID; a readable `GetProcessId` that is not the opened PID) likewise, and
 * `incomplete` (no comparable record) at once.
 */
export type ProcessLiveness =
	| { readonly kind: "live" }
	| { readonly kind: "gone"; readonly reason: "absent" | "birth_mismatch" | "exited" }
	| {
			readonly kind: "unknown";
			readonly reason: "unreadable" | "inconsistent" | "incomplete";
			readonly detail: string;
	  };

const FILETIME = /^\d+$/;

/**
 * The design's observation table over one observation of `record`; a FILETIME is compared exactly, as an integer, and
 * only within one observation domain (a SID marks the handle domain, see above).
 */
export function classifyObservation(record: ProcessRecord, observation: ProcessObservation): ProcessLiveness {
	if (!Number.isInteger(record.pid) || record.pid <= 0) {
		return { kind: "unknown", reason: "incomplete", detail: "no recorded identity" };
	}
	if (observation.kind === "absent") return { kind: "gone", reason: "absent" };
	if (observation.kind === "error") {
		const cause = observation.error instanceof Error ? observation.error.message : String(observation.error);
		return { kind: "unknown", reason: "unreadable", detail: cause };
	}
	const recorded = record.processStartTime;
	const userSid = record.userSid ?? null;
	if (observation.kind === "present") {
		if (userSid !== null) {
			return { kind: "unknown", reason: "incomplete", detail: "handle-domain record, start-time reader" };
		}
		if (recorded === null || !FILETIME.test(recorded) || !FILETIME.test(observation.identity)) {
			return { kind: "unknown", reason: "incomplete", detail: "noncomparable identity" };
		}
		return BigInt(recorded) === BigInt(observation.identity)
			? { kind: "live" }
			: { kind: "gone", reason: "birth_mismatch" };
	}
	const { facts } = observation;
	if (userSid === null) return { kind: "unknown", reason: "incomplete", detail: "no recorded SID" };
	if (facts.handlePid === null) return { kind: "unknown", reason: "unreadable", detail: "GetProcessId unreadable" };
	if (facts.handlePid !== record.pid) {
		return { kind: "unknown", reason: "inconsistent", detail: `GetProcessId ${facts.handlePid}` };
	}
	if (facts.creationTime === null || !FILETIME.test(facts.creationTime) || BigInt(facts.creationTime) === 0n) {
		return { kind: "unknown", reason: "unreadable", detail: "creation time unreadable" };
	}
	if (recorded === null || !FILETIME.test(recorded)) {
		return { kind: "unknown", reason: "incomplete", detail: "noncomparable identity" };
	}
	if (BigInt(recorded) !== BigInt(facts.creationTime)) return { kind: "gone", reason: "birth_mismatch" };
	if (facts.userSid === null) return { kind: "unknown", reason: "unreadable", detail: "SID unreadable" };
	if (facts.userSid !== userSid) return { kind: "unknown", reason: "inconsistent", detail: "SID mismatch" };
	if (facts.exited === null) return { kind: "unknown", reason: "unreadable", detail: "exit state unreadable" };
	return facts.exited ? { kind: "gone", reason: "exited" } : { kind: "live" };
}

/**
 * How a wait on a retained process object ended: `exited` once the object is signalled (with `GetExitCodeProcess`,
 * `null` when unreadable), `cancelled` by the caller's signal or the handle's close, `unavailable` when nothing is
 * retained to wait on (the start-time reader, a closed handle, a failed wait).
 */
export type ProcessExitWait =
	| { readonly kind: "exited"; readonly exitCode: number | null }
	| { readonly kind: "cancelled" }
	| { readonly kind: "unavailable"; readonly reason: string };

/** A process handle this process holds: the observation read on it, a reread of it, and its one release. */
export interface RetainedProcess {
	readonly observation: ProcessObservation;
	/** A fresh observation on the same handle: the facts of that exact instance, its exit state included. */
	observe(): ProcessObservation;
	/**
	 * Resolves when the retained process object is signalled (design 4.2a: "process-object signalling for exit
	 * (`RegisterWaitForSingleObject` or equivalent), not wrapper exit"), or when `signal` aborts or `close` runs first.
	 */
	waitExit(signal?: AbortSignal): Promise<ProcessExitWait>;
	/** Closes the handle. Idempotent. */
	close(): void;
}

/** Where process observations come from: the bridge's retained handles, or the platform's start-time reader. */
export interface ProcessEvidence {
	open(pid: number): Promise<RetainedProcess>;
}

function fromNative(result: NativeProcessObservation): ProcessObservation {
	switch (result.status) {
		case "opened":
			return {
				kind: "opened",
				facts: {
					handlePid: result.handlePid ?? null,
					creationTime: result.creationTime ?? null,
					userSid: result.userSid ?? null,
					exited: result.exited ?? null,
				},
			};
		case "no_such_process":
			return { kind: "absent" };
		default:
			return {
				kind: "error",
				error: new Error(`process observation ${result.status}${result.reason ? ` ${result.reason}` : ""}`),
			};
	}
}

function fromNativeWait(result: NativeProcessObservation): ProcessExitWait {
	switch (result.status) {
		case "exited":
			return { kind: "exited", exitCode: result.exitCode ?? null };
		case "cancelled":
			return { kind: "cancelled" };
		default:
			return { kind: "unavailable", reason: `${result.status}${result.reason ? ` ${result.reason}` : ""}` };
	}
}

/** Evidence through the bridge: one `OpenProcess` per `open`, retained until `close`. */
export function nativeProcessEvidence(native: NativeProcessBinding): ProcessEvidence {
	return {
		async open(pid) {
			const handleId = randomUUID();
			const first = native.processOpen(handleId, pid);
			let open = first.status === "opened";
			return {
				observation: fromNative(first),
				observe: () => (open ? fromNative(native.processObserve(handleId)) : fromNative(first)),
				async waitExit(signal) {
					if (!open) return { kind: "unavailable", reason: "not_held" };
					if (signal?.aborted) return { kind: "cancelled" };
					// The bridge registers the wait ID synchronously, before its thread starts, so a cancel can never miss it.
					const waitId = randomUUID();
					const waiting = native.processWaitExit(handleId, waitId);
					const cancel = () => native.processCancelWaitExit(waitId);
					signal?.addEventListener("abort", cancel, { once: true });
					try {
						return fromNativeWait(await waiting);
					} finally {
						signal?.removeEventListener("abort", cancel);
					}
				},
				close: () => {
					if (!open) return;
					open = false;
					native.processClose(handleId);
				},
			};
		},
	};
}

/** Nothing retained: no object to wait on. The ChildProcess exit event stays the only exit signal off the bridge. */
const noExitWait = async (): Promise<ProcessExitWait> => ({ kind: "unavailable", reason: "no retained handle" });

/**
 * Evidence from a start-time reader (`readProcessStartTime` and the probes tests inject): `undefined` is an absent PID,
 * a throw is an unreadable one. Nothing is retained, so `observe` repeats the answer read at `open`.
 */
export function startTimeEvidence(read: (pid: number) => Promise<string | undefined>): ProcessEvidence {
	return {
		async open(pid) {
			const observation = await read(pid).then(
				(identity): ProcessObservation =>
					identity === undefined ? { kind: "absent" } : { kind: "present", identity },
				(error: unknown): ProcessObservation => ({ kind: "error", error }),
			);
			return { observation, observe: () => observation, waitExit: noExitWait, close: () => {} };
		},
	};
}

/** Evidence from the identity reader with a per-query budget (`readProcessIdentity`): the recovery source off the bridge. */
export function identityReaderEvidence(budgetMs: number): ProcessEvidence {
	return {
		async open(pid) {
			const observation = await readProcessIdentity(pid, process.platform, budgetMs);
			return { observation, observe: () => observation, waitExit: noExitWait, close: () => {} };
		},
	};
}

/**
 * The evidence source of this invocation: the bridge when the placement natives loaded (Windows), otherwise the given
 * start-time reader, which is today's behaviour everywhere else.
 */
export function processEvidence(
	native: PresencePlacementLoad,
	fallback: (pid: number) => Promise<string | undefined> = (pid) => readProcessStartTime(pid),
): ProcessEvidence {
	return native.status === "available" ? nativeProcessEvidence(native.native) : startTimeEvidence(fallback);
}

/**
 * The identity of `pid` as the bridge reads it on one handle of it, closed at once: PID, the complete creation FILETIME
 * and the `TokenUser` SID, the handle domain. `undefined` when the bridge is unavailable or the handle answers no
 * creation time or no SID; the caller then records through its platform reader, as before, or leaves the record
 * unverified. A FILETIME without its SID is never returned: the SID is what marks the record as the handle's, and
 * without it the 100 ns value would be read as the reader's microsecond one and compared across domains. The daemon's
 * own records (the generation record, `host-child.pid`, the session claims) are written this way so the recovery
 * census compares them in the domain it observes in.
 */
export async function bridgeProcessIdentity(
	native: PresencePlacementLoad,
	pid: number,
): Promise<ProcessRecord | undefined> {
	if (native.status !== "available") return undefined;
	const retained = await nativeProcessEvidence(native.native).open(pid);
	try {
		const { observation } = retained;
		if (observation.kind !== "opened") return undefined;
		const { creationTime, userSid } = observation.facts;
		if (creationTime === null || userSid === null) return undefined;
		return { pid, processStartTime: creationTime, userSid };
	} finally {
		retained.close();
	}
}

/**
 * This process's own recorded identity (the claimant's `self`, the issuer's identity): through the bridge, its PID,
 * creation FILETIME and SID read on one handle of itself, closed at once; otherwise its PID and start time, with an
 * unreadable start time recorded as unverified (`null`) as before.
 */
export async function ownProcessIdentity(native: PresencePlacementLoad): Promise<ProcessRecord> {
	const pid = process.pid;
	const own = await bridgeProcessIdentity(native, pid);
	if (own) return own;
	const processStartTime = (await readProcessStartTime(pid).catch(() => undefined)) ?? null;
	return { pid, processStartTime, userSid: null };
}
