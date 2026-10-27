/**
 * The Repair connection workflow of a Windows public endpoint, engine half (sisyphuslabs/omo-desktop-app#4199, design
 * 4.2a Revision 6 "Visible Repair connection action", Revision 7 "Repair amendments", Revision 8 r7 note 4; tests 20
 * and 26). An explicit user action that authorizes one bounded repair workflow and nothing destructive: no record
 * deletion, lock stealing, raw-PID signal, credential rotation or alternate endpoint.
 *
 * - It reruns the recovery transaction under the endpoint lock as one new bounded assessment (`fresh`), so an unchanged
 *   escalated record is observed again, at most twice, and recovers only from actual proof.
 * - Busy owner first: when that check finds an admissible presence object visibly held, its owner is alive, and the
 *   bridge waits for the kernel to release that lock with a blocking `LockFileEx` in a native worker thread, an event
 *   rather than polling and never a deadline (Windows documents that release can be delayed). The wait holds no state
 *   transaction and no endpoint lock; the endpoint lock is taken only after acquiring. The handle that acquires is the
 *   retained recovery guard for that object: it is never closed and reacquired before the check, the check applies the
 *   admissibility rules to it as step 3's acquisition, and it leaves with the attempt (after the retirement commit, or at
 *   once when the attempt cannot retire). Dismissing the card cancels the wait (`CancelIoEx`) and releases nothing the
 *   wait did not acquire.
 * - Restart only where it proves something: a confirmed restart persists the owner-checked repair anchor (the current
 *   verified kernel session at the fenced generation and revision) only when the refusal offers `restart_computer`, so
 *   only for a local-store endpoint whose rows have same-kernel provenance. A source that cannot attest its boot records
 *   no anchor; after the restart the lifetime acquisition recovers instead. Cancelling the OS action leaves everything
 *   intact.
 */
import { randomUUID } from "node:crypto";
import {
	type EndpointReservationStore,
	EndpointReservationError,
	type PresenceObjectRecord,
	type RepairAnchor,
} from "./endpoint-reservation-store.ts";
import {
	type RecoveredGuard,
	type RecoveryOutcome,
	type RecoveryProber,
	recoverEndpointReservations,
} from "./endpoint-recovery.ts";
import type { HostDaemonDirectory } from "./host-daemon-paths.ts";

export type RepairOutcome =
	| Extract<RecoveryOutcome, { status: "recovered" }>
	| (Extract<RecoveryOutcome, { status: "refused" }> & {
			/**
			 * With `confirmRestart`, when the refusal offers `restart_computer`: the anchor recorded, or `null` when this
			 * kernel session is unverified and no anchor can attest a boot change. Absent for every other action.
			 */
			readonly anchor?: RepairAnchor | null;
	  })
	/** The wait was cancelled before it acquired; nothing changed. */
	| { readonly status: "cancelled" };

export interface RepairRequest {
	readonly store: EndpointReservationStore;
	readonly endpoint: string;
	readonly paths: HostDaemonDirectory;
	readonly prober: RecoveryProber;
	/** Runs `run` under the endpoint lock; the busy-owner wait runs outside it. */
	readonly withEndpointLock: <T>(run: () => Promise<T>) => Promise<T>;
	/** The user confirmed "Restart this computer": persist the repair anchor where the restart proves something. */
	readonly confirmRestart?: boolean;
	/** Dismissing the card: cancels an outstanding wait. */
	readonly signal?: AbortSignal;
}

/** One explicit Repair: the bounded check, the busy-owner wait when it is the remaining step, the anchor when confirmed. */
export async function repairEndpointReservations(request: RepairRequest): Promise<RepairOutcome> {
	if (request.signal?.aborted) return { status: "cancelled" };
	const { store, endpoint, paths, prober } = request;
	const check = (held?: RecoveredGuard) =>
		request.withEndpointLock(async () => {
			const outcome = await recoverEndpointReservations(store, endpoint, paths, { ...prober, fresh: true, held });
			if (outcome.status !== "refused" || !request.confirmRestart || outcome.action !== "restart_computer") {
				return outcome;
			}
			return { ...outcome, anchor: recordAnchor(store, outcome.generation, prober) };
		});
	const first = await check();
	if (first.status !== "refused" || first.reason !== "presence_occupied" || first.occupied === undefined) return first;
	if (request.confirmRestart) return first;
	// Busy owner first: wait for the kernel's release of that object's lock, then run the bounded check holding it.
	const waited = await waitForRelease(first.occupied, prober, request.signal);
	if (waited.status === "cancelled") return { status: "cancelled" };
	return check(waited.status === "acquired" ? waited.held : undefined);
}

/**
 * The owner-checked anchor, recorded only under a verified current session; an unverified session records nothing and
 * is reported `null`, so the user still restarts and the lifetime acquisition after it is the proof.
 */
function recordAnchor(
	store: EndpointReservationStore,
	generation: string,
	prober: RecoveryProber,
): RepairAnchor | null {
	try {
		return store.recordRepairAnchor(generation, prober.session);
	} catch (error: unknown) {
		if (error instanceof EndpointReservationError && error.reason === "anchor_unverifiable") return null;
		throw error;
	}
}

type WaitResult =
	| { readonly status: "acquired"; readonly held: RecoveredGuard }
	| { readonly status: "cancelled" }
	| { readonly status: "unknown" };

/**
 * The bridge's blocking, cancellable wait on one presence object. The cancellation token is registered by the native
 * call before its worker starts, so an abort delivered at any moment ends the wait; an abort after acquisition releases
 * nothing here, because the acquired handle is the check's guard. A wait that ends neither acquired nor cancelled
 * (the object vanished, the registry is fenced) leaves the check to run without a guard.
 */
async function waitForRelease(
	object: PresenceObjectRecord,
	prober: RecoveryProber,
	signal: AbortSignal | undefined,
): Promise<WaitResult> {
	if (object.status !== "predeclared" || prober.native.status !== "available") return { status: "unknown" };
	const bridge = prober.native.native;
	const waitId = randomUUID();
	const cancel = () => bridge.presenceCancelWait(waitId);
	signal?.addEventListener("abort", cancel, { once: true });
	let result: Awaited<ReturnType<typeof bridge.presenceWaitAndAcquire>>;
	try {
		result = await bridge.presenceWaitAndAcquire(object.presenceId, object.path, waitId);
	} finally {
		signal?.removeEventListener("abort", cancel);
	}
	if (result.status === "cancelled") return { status: "cancelled" };
	if (result.status !== "acquired") return { status: "unknown" };
	let released = false;
	return {
		status: "acquired",
		held: {
			presenceId: object.presenceId,
			release: () => {
				if (released) return;
				released = true;
				bridge.presenceReleaseAfterQuiescence({ presenceId: object.presenceId, state: "released" });
			},
		},
	};
}
