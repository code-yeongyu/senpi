/**
 * The user-facing part of an extension failure: what happened and what the user can do about it.
 *
 * Hosts render only these fields (never the stack or the raw message) wherever the failure reaches a
 * person. Recognition is structural, through an own `userFacing` property, so an extension bundled with
 * its own copy of this class, or one that never imports senpi, can still opt in.
 */
export interface UserFacingErrorInfo {
	/** Stable machine code, e.g. `COMPUTER_LAUNCH_CONTEXT_REQUIRED`: letters, digits, `_`, `.`, `-`. */
	readonly code: string;
	/** What happened, in one plain sentence without stack frames or internal paths. */
	readonly message: string;
	/** What the user can do next. */
	readonly action?: string;
	/** An http(s) page with more help. */
	readonly docsUrl?: string;
}

export class UserFacingError extends Error {
	readonly userFacing: UserFacingErrorInfo;

	constructor(info: UserFacingErrorInfo, options?: ErrorOptions) {
		const text = info.action === undefined ? info.message : `${info.message} ${info.action}`;
		super(`${info.code}: ${text}`, options);
		this.name = "UserFacingError";
		this.userFacing = { ...info };
	}
}

const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_FIELD_CHARACTERS = 1000;

function textField(record: object, key: string): string | undefined {
	const value: unknown = key in record ? Reflect.get(record, key) : undefined;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed.slice(0, MAX_FIELD_CHARACTERS);
}

/** Read the user-facing contract off a thrown value; anything malformed counts as an unexpected error. */
export function userFacingErrorOf(value: unknown): UserFacingErrorInfo | undefined {
	if (typeof value !== "object" || value === null || !("userFacing" in value)) return undefined;
	const info = value.userFacing;
	if (typeof info !== "object" || info === null) return undefined;
	const code = textField(info, "code");
	const message = textField(info, "message");
	if (code === undefined || message === undefined || !CODE_PATTERN.test(code)) return undefined;
	if ("action" in info && info.action !== undefined && typeof info.action !== "string") return undefined;
	const action = textField(info, "action");
	const docsUrl = textField(info, "docsUrl");
	return {
		code,
		message,
		...(action === undefined ? {} : { action }),
		...(docsUrl !== undefined && /^https?:\/\//i.test(docsUrl) ? { docsUrl } : {}),
	};
}

/** The `ExtensionError` fields every capture site derives from a thrown value. */
export function extensionFailureFields(thrown: unknown): {
	readonly error: string;
	readonly stack?: string;
	readonly userFacing?: UserFacingErrorInfo;
} {
	const userFacing = userFacingErrorOf(thrown);
	return {
		error: thrown instanceof Error ? thrown.message : String(thrown),
		...(thrown instanceof Error && thrown.stack !== undefined ? { stack: thrown.stack } : {}),
		...(userFacing === undefined ? {} : { userFacing }),
	};
}
