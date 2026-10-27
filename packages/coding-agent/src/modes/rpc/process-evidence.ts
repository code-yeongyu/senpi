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
 * What an observation says about the recorded instance. `unknown` names the design's escalation reason: `unreadable`
 * (denied or failed open, an unreadable field) is requeried once by the caller's budget, `inconsistent` (same birth,
 * another SID; `GetProcessId` not the opened PID) likewise, and `incomplete` (no comparable record) at once.
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

/** The design's observation table over one observation of `record`; a FILETIME is compared exactly, as an integer. */
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
	if (observation.kind === "present") {
		if (recorded === null || !FILETIME.test(recorded) || !FILETIME.test(observation.identity)) {
			return { kind: "unknown", reason: "incomplete", detail: "noncomparable identity" };
		}
		return BigInt(recorded) === BigInt(observation.identity)
			? { kind: "live" }
			: { kind: "gone", reason: "birth_mismatch" };
	}
	const { facts } = observation;
	if (facts.handlePid !== record.pid) {
		return { kind: "unknown", reason: "inconsistent", detail: `GetProcessId ${facts.handlePid ?? "unreadable"}` };
	}
	if (facts.creationTime === null || !FILETIME.test(facts.creationTime) || BigInt(facts.creationTime) === 0n) {
		return { kind: "unknown", reason: "unreadable", detail: "creation time unreadable" };
	}
	if (recorded === null || !FILETIME.test(recorded)) {
		return { kind: "unknown", reason: "incomplete", detail: "noncomparable identity" };
	}
	if (BigInt(recorded) !== BigInt(facts.creationTime)) return { kind: "gone", reason: "birth_mismatch" };
	const userSid = record.userSid ?? null;
	if (userSid === null) return { kind: "unknown", reason: "incomplete", detail: "no recorded SID" };
	if (facts.userSid === null) return { kind: "unknown", reason: "unreadable", detail: "SID unreadable" };
	if (facts.userSid !== userSid) return { kind: "unknown", reason: "inconsistent", detail: "SID mismatch" };
	if (facts.exited === null) return { kind: "unknown", reason: "unreadable", detail: "exit state unreadable" };
	return facts.exited ? { kind: "gone", reason: "exited" } : { kind: "live" };
}

/** A process handle this process holds: the observation read on it, a reread of it, and its one release. */
export interface RetainedProcess {
	readonly observation: ProcessObservation;
	/** A fresh observation on the same handle: the facts of that exact instance, its exit state included. */
	observe(): ProcessObservation;
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
				close: () => {
					if (!open) return;
					open = false;
					native.processClose(handleId);
				},
			};
		},
	};
}

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
			return { observation, observe: () => observation, close: () => {} };
		},
	};
}

/** Evidence from the identity reader with a per-query budget (`readProcessIdentity`): the recovery source off the bridge. */
export function identityReaderEvidence(budgetMs: number): ProcessEvidence {
	return {
		async open(pid) {
			const observation = await readProcessIdentity(pid, process.platform, budgetMs);
			return { observation, observe: () => observation, close: () => {} };
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
 * This process's own recorded identity (the claimant's `self`, the issuer's identity): through the bridge, its PID,
 * creation FILETIME and SID read on one handle of itself, closed at once; otherwise its PID and start time, with an
 * unreadable start time recorded as unverified (`null`) as before.
 */
export async function ownProcessIdentity(native: PresencePlacementLoad): Promise<ProcessRecord> {
	const pid = process.pid;
	if (native.status === "available") {
		const retained = await nativeProcessEvidence(native.native).open(pid);
		try {
			const { observation } = retained;
			if (observation.kind === "opened" && observation.facts.creationTime !== null) {
				return { pid, processStartTime: observation.facts.creationTime, userSid: observation.facts.userSid };
			}
		} finally {
			retained.close();
		}
	}
	const processStartTime = (await readProcessStartTime(pid).catch(() => undefined)) ?? null;
	return { pid, processStartTime, userSid: null };
}
