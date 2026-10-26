export type ConfigReferenceReason =
	| "malformed"
	| "forbidden"
	| "unset"
	| "empty"
	| "missing"
	| "unreadable"
	| "oversize"
	| "invalid-utf8"
	| "non-regular"
	| "unsafe-owner"
	| "unsafe-permissions"
	| "changed";

/** Contains the declaration, never resolved credential bytes. */
export class ConfigReferenceError extends Error {
	readonly field: string;
	readonly reference: unknown;
	readonly reason: ConfigReferenceReason;

	constructor(field: string, reference: unknown, reason: ConfigReferenceReason) {
		super(`${field}: configuration reference ${reason}`);
		this.name = "ConfigReferenceError";
		this.field = field;
		this.reference = reference;
		this.reason = reason;
	}
}
