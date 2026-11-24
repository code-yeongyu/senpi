import { formatThrownValue } from "./diagnostics.ts";

/** `stale_login`: a sign-out named a `loginId` the stored sign-in no longer carries; nothing changed (senpi#7406). */
export type ModelsErrorCode =
	| "model_source"
	| "model_validation"
	| "provider"
	| "stream"
	| "auth"
	| "oauth"
	| "stale_login";

export class ModelsError extends Error {
	readonly code: ModelsErrorCode;

	constructor(code: ModelsErrorCode, message: string, options?: { cause?: unknown }) {
		super(withCauseDetail(message, options?.cause), options);
		this.name = "ModelsError";
		this.code = code;
	}
}

/** Callers surface `error.message` only, so keep the underlying reason in it. */
function withCauseDetail(message: string, cause: unknown): string {
	if (cause === undefined || cause === null) return message;
	const detail = formatThrownValue(cause).trim();
	if (!detail || message.includes(detail)) return message;
	return `${message}: ${detail}`;
}
