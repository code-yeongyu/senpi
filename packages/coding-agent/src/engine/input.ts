import { type EngineError, engineError } from "./result.ts";

/**
 * The exported functions' runtime input boundary: a JavaScript caller can omit a required field or pass the
 * wrong type, so each required field is read from an `unknown` input and a missing or mistyped one is the
 * typed `invalid_input` refusal naming that field, never a thrown dereference.
 */
export type InvalidInput = EngineError<"invalid_input">;

export function invalidInput(field: string, expected: string): InvalidInput {
	return engineError("invalid_input", `${field} must be ${expected}`, { details: { input: field } });
}

function field(input: unknown, key: string): unknown {
	return typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined;
}

export function requiredString(input: unknown, key: string): string | InvalidInput {
	const value = field(input, key);
	return typeof value === "string" ? value : invalidInput(key, "a string");
}

export function requiredNumber(input: unknown, key: string): number | InvalidInput {
	const value = field(input, key);
	return typeof value === "number" ? value : invalidInput(key, "a number");
}

export function requiredBoolean(input: unknown, key: string): boolean | InvalidInput {
	const value = field(input, key);
	return typeof value === "boolean" ? value : invalidInput(key, "a boolean");
}

export function requiredOneOf<T extends string>(input: unknown, key: string, allowed: readonly T[]): T | InvalidInput {
	const value = field(input, key);
	return typeof value === "string" && (allowed as readonly string[]).includes(value)
		? (value as T)
		: invalidInput(key, `one of ${allowed.join(", ")}`);
}

export function requiredObject(input: unknown, key: string): Readonly<Record<string, unknown>> | InvalidInput {
	const value = field(input, key);
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: invalidInput(key, "an object");
}

/** An optional field: absent is `undefined`; present with the wrong type is the refusal. */
export function optionalBoolean(input: unknown, key: string): boolean | undefined | InvalidInput {
	const value = field(input, key);
	return value === undefined || typeof value === "boolean" ? value : invalidInput(key, "a boolean when given");
}

export function optionalString(input: unknown, key: string): string | undefined | InvalidInput {
	const value = field(input, key);
	return value === undefined || typeof value === "string" ? value : invalidInput(key, "a string when given");
}

export function optionalNumber(input: unknown, key: string): number | undefined | InvalidInput {
	const value = field(input, key);
	return value === undefined || typeof value === "number" ? value : invalidInput(key, "a number when given");
}

export function isInvalid(value: unknown): value is InvalidInput {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "error";
}
