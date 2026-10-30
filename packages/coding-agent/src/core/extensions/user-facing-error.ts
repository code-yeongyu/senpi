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
const TERMINAL_SEQUENCES = /\u001b\][\s\S]*?(?:\u0007|\u001b\\|\u009c|$)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Read one property of a value an extension threw. The value is untrusted: a getter or a Proxy trap may throw,
 * and that must never escape the runner's catch block, so any throw counts as "no such property".
 */
function readProperty(value: object, key: string): unknown {
	try {
		return Reflect.get(value, key);
	} catch {
		return undefined;
	}
}

/** One display line: terminal sequences and control characters removed, whitespace collapsed, length capped. */
function textField(record: object, key: string): string | undefined {
	const value = readProperty(record, key);
	if (typeof value !== "string") return undefined;
	const line = value.replace(TERMINAL_SEQUENCES, "").replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
	return line.length === 0 ? undefined : Array.from(line).slice(0, MAX_FIELD_CHARACTERS).join("");
}

/** Read the user-facing contract off a thrown value; anything malformed counts as an unexpected error. */
export function userFacingErrorOf(value: unknown): UserFacingErrorInfo | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const info = readProperty(value, "userFacing");
	if (typeof info !== "object" || info === null) return undefined;
	const code = textField(info, "code");
	const message = textField(info, "message");
	if (code === undefined || message === undefined || !CODE_PATTERN.test(code)) return undefined;
	const rawAction = readProperty(info, "action");
	if (rawAction !== undefined && typeof rawAction !== "string") return undefined;
	const action = textField(info, "action");
	const docsUrl = textField(info, "docsUrl");
	return {
		code,
		message,
		...(action === undefined ? {} : { action }),
		...(docsUrl !== undefined && /^https?:\/\/\S+$/i.test(docsUrl) ? { docsUrl } : {}),
	};
}

function errorText(thrown: unknown, key: "message" | "stack"): string | undefined {
	if (!(thrown instanceof Error)) return undefined;
	const value = readProperty(thrown, key);
	return typeof value === "string" ? value : undefined;
}

function describeThrown(thrown: unknown): string {
	const message = errorText(thrown, "message");
	if (message !== undefined) return message;
	try {
		return String(thrown);
	} catch {
		return "an unprintable value was thrown";
	}
}

/** The `ExtensionError` fields every capture site derives from a thrown value; never throws. */
export function extensionFailureFields(thrown: unknown): {
	readonly error: string;
	readonly stack?: string;
	readonly userFacing?: UserFacingErrorInfo;
} {
	const userFacing = userFacingErrorOf(thrown);
	const stack = errorText(thrown, "stack");
	return {
		error: describeThrown(thrown),
		...(stack === undefined ? {} : { stack }),
		...(userFacing === undefined ? {} : { userFacing }),
	};
}
