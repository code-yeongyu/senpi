import type { StoreValue } from "../durable/store.ts";
import type { ExecutionEntry, ExecutionOutcome, ExecutionProgress, FrozenCall } from "./ledger-types.ts";

function object(value: StoreValue | undefined): value is { readonly [key: string]: StoreValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function frozen(value: StoreValue | undefined): value is FrozenCall {
	return (
		object(value) && typeof value.name === "string" && typeof value.digest === "string" && value.args !== undefined
	);
}

function outcome(value: StoreValue | undefined): value is ExecutionOutcome {
	if (!object(value) || typeof value.hooksRan !== "boolean" || typeof value.uncertain !== "boolean") return false;
	switch (value.reason) {
		case "result":
			return value.value !== undefined && value.uncertain === false;
		case "cancelled":
		case "lease_expired":
		case "hand_restarted":
		case "uncertain":
			return true;
		default:
			return false;
	}
}

function progress(value: StoreValue | undefined): value is ExecutionProgress {
	if (!object(value)) return false;
	switch (value.state) {
		case "admitted":
		case "preparing":
		case "acked":
			return true;
		case "prepared":
		case "prepared_awaiting_consent":
		case "released":
		case "dispatched":
			return frozen(value.call);
		case "reconciling":
			return frozen(value.call) && typeof value.until === "number" && Number.isFinite(value.until);
		case "settled":
			return outcome(value.outcome);
		default:
			return false;
	}
}

function entry(value: StoreValue): value is ExecutionEntry {
	return (
		object(value) &&
		["issuer", "commandId", "executor", "workspace", "scope", "requestDigest"].every(
			(key) => typeof value[key] === "string",
		) &&
		["generation", "admittedAt", "leaseUntil", "initialLeaseUntil", "renewSeq"].every(
			(key) => typeof value[key] === "number" && Number.isFinite(value[key]),
		) &&
		typeof value.reconcilable === "boolean" &&
		typeof value.effectPossible === "boolean" &&
		typeof value.bodyDispatched === "boolean" &&
		progress(value.progress)
	);
}

class ExecutionLedgerCorruptError extends Error {
	constructor() {
		super("invalid durable execution ledger row");
		this.name = "ExecutionLedgerCorruptError";
	}
}

/** Stored JSON crosses its schema boundary once, on read. A corrupt row must never look like a missing execution. */
export function decodeExecution(value: StoreValue): ExecutionEntry {
	if (!entry(value)) throw new ExecutionLedgerCorruptError();
	return value;
}
