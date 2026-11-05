import type { StoreValue } from "../durable/store.ts";
import type { ActivityRecord, NestedChild, NestedParent, NestedRecord } from "./nested-types.ts";

type StoreObject = { readonly [key: string]: StoreValue };

const object = (value: StoreValue | undefined): value is StoreObject =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: StoreObject, keys: readonly string[]): boolean =>
	keys.every((key) => typeof value[key] === "string");
const numbers = (value: StoreObject, keys: readonly string[]): boolean =>
	keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]));
const stringList = (value: StoreValue | undefined): boolean =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string");

function parent(value: StoreValue | undefined): value is NestedParent {
	return (
		object(value) &&
		strings(value, ["executionId", "executor", "scope"]) &&
		numbers(value, ["generation", "admittedAt", "leaseUntil", "budget"]) &&
		object(value.capabilities) &&
		stringList(value.capabilities.preparation) &&
		stringList(value.capabilities.body)
	);
}

function child(value: StoreValue | undefined): value is NestedChild {
	return (
		object(value) &&
		strings(value, ["executionId", "target"]) &&
		numbers(value, ["cost"]) &&
		value.origin === "tool" &&
		(value.activityId === null || typeof value.activityId === "string")
	);
}

function activity(value: StoreValue | undefined): value is ActivityRecord {
	return (
		object(value) &&
		strings(value, ["activityId", "parent", "executor", "scope"]) &&
		numbers(value, ["budget", "expiresAt", "debited"]) &&
		stringList(value.targets) &&
		typeof value.ended === "boolean"
	);
}

const each = (value: StoreValue | undefined, check: (entry: StoreValue) => boolean): boolean =>
	object(value) && Object.values(value).every(check);

/** Decodes the brain's nested record; anything else is a corrupt store, never a guess. */
export function decodeNestedRecord(value: StoreValue): NestedRecord {
	if (
		object(value) &&
		parent(value.parent) &&
		(value.phase === "preparation" || value.phase === "body" || value.phase === "settled") &&
		typeof value.cancelled === "boolean" &&
		numbers(value, ["expiresAt", "debited"]) &&
		each(value.children, child) &&
		each(value.activities, activity) &&
		each(value.cancels, (entry) => entry === "queued" || entry === "delivered")
	)
		return value as NestedRecord;
	throw new Error("corrupt nested admission record");
}
