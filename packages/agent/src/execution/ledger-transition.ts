import {
	applied,
	type ExecutionCommand,
	type ExecutionEntry,
	type ExecutionOutcome,
	type ExecutionProgress,
	type LedgerReply,
	MAX_EXECUTION_LIFETIME_MS,
	RECONCILIATION_GRACE_MS,
	refused,
	replayed,
} from "./ledger-types.ts";

const advance = (entry: ExecutionEntry, progress: ExecutionProgress): LedgerReply => applied({ ...entry, progress });
const settle = (entry: ExecutionEntry, reason: Exclude<ExecutionOutcome["reason"], "result">): LedgerReply =>
	advance(entry, {
		state: "settled",
		outcome: { reason, hooksRan: entry.effectPossible, uncertain: entry.effectPossible || entry.bodyDispatched },
	});

function authorized(entry: ExecutionEntry, { actor, event }: ExecutionCommand): boolean {
	switch (event.kind) {
		case "cancel":
			return actor.id === entry.issuer || actor.approvedWorkspace === entry.workspace;
		case "consent":
		case "release":
		case "abort":
		case "ack":
		case "renew":
			return actor.id === entry.issuer;
		case "prepare":
		case "effect":
		case "freeze":
		case "dispatch":
		case "result":
		case "expire":
		case "restart":
			return actor.id === entry.executor;
	}
}

function recover(entry: ExecutionEntry, now: number): LedgerReply {
	switch (entry.progress.state) {
		case "admitted":
		case "preparing":
			return settle(entry, "hand_restarted");
		case "dispatched":
			return entry.reconcilable
				? advance(entry, {
						state: "reconciling",
						call: entry.progress.call,
						until: Math.min(entry.leaseUntil, now + RECONCILIATION_GRACE_MS),
					})
				: settle(entry, "hand_restarted");
		case "reconciling":
			return now >= entry.progress.until ? settle(entry, "hand_restarted") : replayed(entry);
		case "prepared":
		case "prepared_awaiting_consent":
		case "released":
		case "settled":
		case "acked":
			return replayed(entry);
	}
}

/** A body may run only for an applied reply in state `dispatched`, never for an expiry settlement or replay. */
export function transitionExecution(entry: ExecutionEntry, command: ExecutionCommand): LedgerReply {
	const { event, now } = command;
	if (command.generation !== entry.generation) return refused("stale_generation");
	if (!authorized(entry, command)) return refused("unauthorized");
	if (!Number.isFinite(now) || now < entry.admittedAt) return refused("invalid_time");
	const progress = entry.progress;
	if (progress.state === "acked")
		return event.kind === "ack" ? { status: "replayed", entry } : { status: "result_expired" };
	if (progress.state === "settled") {
		switch (event.kind) {
			case "ack":
				return advance(entry, { state: "acked" });
			case "release":
			case "abort":
			case "consent":
				return refused("terminal");
			default:
				return replayed(entry);
		}
	}
	if (now >= entry.leaseUntil) return settle(entry, "lease_expired");
	if (progress.state === "reconciling" && now >= progress.until) return settle(entry, "hand_restarted");
	switch (event.kind) {
		case "prepare":
			return progress.state === "admitted" ? advance(entry, { state: "preparing" }) : replayed(entry);
		case "effect":
			if (entry.effectPossible) return replayed(entry);
			return progress.state === "preparing"
				? applied({ ...entry, effectPossible: true })
				: refused("invalid_transition");
		case "freeze":
			if (progress.state === "preparing" && entry.effectPossible) {
				return advance(entry, {
					state: event.awaitingConsent ? "prepared_awaiting_consent" : "prepared",
					call: event.call,
				});
			}
			return "call" in progress && progress.call.digest === event.call.digest
				? replayed(entry)
				: refused("invalid_transition");
		case "consent":
			return progress.state === "prepared_awaiting_consent"
				? advance(entry, { state: "prepared", call: progress.call })
				: refused("invalid_transition");
		case "release":
			if (progress.state === "prepared") return advance(entry, { state: "released", call: progress.call });
			return progress.state === "released" || entry.bodyDispatched ? replayed(entry) : refused("invalid_transition");
		case "dispatch":
			if (entry.bodyDispatched) return replayed(entry);
			return progress.state === "released"
				? applied({ ...entry, bodyDispatched: true, progress: { state: "dispatched", call: progress.call } })
				: refused("invalid_transition");
		case "result":
			if (progress.state !== "dispatched" && progress.state !== "reconciling") return refused("invalid_transition");
			return advance(entry, {
				state: "settled",
				outcome: { reason: "result", value: event.value, hooksRan: entry.effectPossible, uncertain: false },
			});
		case "cancel":
			return settle(entry, "cancelled");
		case "abort":
			return entry.bodyDispatched ? refused("invalid_transition") : settle(entry, "cancelled");
		case "ack":
			return refused("invalid_transition");
		case "renew":
			if (event.seq <= entry.renewSeq) return replayed(entry);
			if (
				!Number.isSafeInteger(event.seq) ||
				!Number.isFinite(event.leaseUntil) ||
				event.leaseUntil <= entry.leaseUntil ||
				event.leaseUntil > entry.admittedAt + MAX_EXECUTION_LIFETIME_MS
			)
				return refused("invalid_renewal");
			return applied({ ...entry, renewSeq: event.seq, leaseUntil: event.leaseUntil });
		case "expire":
			return replayed(entry);
		case "restart":
			return recover(entry, now);
	}
}
