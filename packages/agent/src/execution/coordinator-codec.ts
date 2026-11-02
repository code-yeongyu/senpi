import type { StoreValue } from "../durable/store.ts";
import type { BatchManifest, BatchRecord, CallOutcome, ManifestCall, PrepareReply } from "./coordinator-types.ts";

type StoreObject = { readonly [key: string]: StoreValue };

function object(value: StoreValue | undefined): value is StoreObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: StoreObject, keys: readonly string[]): boolean {
	return keys.every((key) => typeof value[key] === "string");
}

function numbers(value: StoreObject, keys: readonly string[]): boolean {
	return keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]));
}

function terminal(value: StoreValue | undefined): boolean {
	if (!object(value) || typeof value.hooksRan !== "boolean" || typeof value.uncertain !== "boolean") return false;
	return value.reason === "result"
		? value.value !== undefined
		: ["cancelled", "lease_expired", "hand_restarted", "uncertain"].includes(String(value.reason));
}

function manifestCall(value: StoreValue | undefined): value is ManifestCall {
	return (
		object(value) &&
		strings(value, ["executionId", "executor", "name", "requestDigest"]) &&
		numbers(value, ["sourceIndex", "wave"]) &&
		typeof value.sequential === "boolean" &&
		value.args !== undefined &&
		Array.isArray(value.dependsOn) &&
		value.dependsOn.every((dependency) => typeof dependency === "number")
	);
}

function manifest(value: StoreValue | undefined): value is BatchManifest {
	return (
		object(value) &&
		strings(value, ["batchId", "scope", "workspace", "issuer", "manifestDigest"]) &&
		numbers(value, ["generation", "admittedAt", "leaseUntil"]) &&
		Array.isArray(value.calls) &&
		value.calls.every(manifestCall)
	);
}

function prepareReply(value: StoreValue | undefined): value is PrepareReply {
	if (!object(value)) return false;
	switch (value.kind) {
		case "prepared":
			return typeof value.frozenDigest === "string";
		case "blocked":
			return value.result !== undefined;
		case "batch_abort":
			return true;
		case "settled":
			return terminal(value.outcome);
		default:
			return false;
	}
}

function callOutcome(value: StoreValue | undefined): value is CallOutcome {
	if (!object(value)) return false;
	switch (value.kind) {
		case "result":
			return value.value !== undefined;
		case "blocked":
			return value.result !== undefined;
		case "not_run":
			return value.cause === "batch_abort" || value.cause === "interrupted_preparation";
		case "interrupted":
			return typeof value.reason === "string" && typeof value.uncertain === "boolean";
		default:
			return false;
	}
}

function record(value: StoreValue): value is BatchRecord {
	if (!object(value) || !manifest(value.manifest)) return false;
	const size = value.manifest.calls.length;
	const { prepares, released, outcomes, decision } = value;
	return (
		(decision === null || decision === "RELEASE" || decision === "ABORT") &&
		Array.isArray(prepares) &&
		prepares.length === size &&
		prepares.every((reply) => reply === null || prepareReply(reply)) &&
		Array.isArray(released) &&
		released.length === size &&
		released.every((mark) => typeof mark === "boolean") &&
		Array.isArray(outcomes) &&
		outcomes.length === size &&
		outcomes.every((outcome) => outcome === null || callOutcome(outcome))
	);
}

class BatchRecordCorruptError extends Error {
	constructor() {
		super("invalid durable batch record");
		this.name = "BatchRecordCorruptError";
	}
}

/** Stored JSON crosses its schema boundary once, on read. A corrupt record must never look like a missing batch. */
export function decodeBatchRecord(value: StoreValue): BatchRecord {
	if (!record(value)) throw new BatchRecordCorruptError();
	return value;
}
