import { stripBom } from "../utils/text.ts";
import { CredentialStoreBusyError } from "./lockfile-policy.ts";

export type AuthStoreLoadErrorKind = "malformed_json" | "invalid_format" | "unreadable" | "write_back_failed";

/**
 * Why an existing auth.json could not be loaded (senpi#4413). `reason` is safe to show and send to
 * clients: it never carries the file's path or contents.
 */
export interface AuthStoreLoadError {
	readonly kind: AuthStoreLoadErrorKind;
	readonly reason: string;
}

export class AuthStoreUnreadableError extends Error {
	readonly loadError: AuthStoreLoadError;

	constructor(loadError: AuthStoreLoadError) {
		super(
			`Your sign-in store (auth.json) could not be read: ${loadError.reason}. Nothing was changed; repair or move auth.json in the agent directory, then sign in again.`,
		);
		this.name = "AuthStoreUnreadableError";
		this.loadError = loadError;
	}
}

/**
 * A store load that failed after auth.json was read and parsed: saving its repaired or migrated copy
 * failed (`wroteBack`), or the lock was lost once the read was done. Neither means the file is unreadable.
 */
class AuthStoreAfterReadError extends Error {
	readonly wroteBack: boolean;

	constructor(cause: unknown, wroteBack: boolean) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(
			wroteBack
				? `auth.json was read, but saving its repaired or migrated copy failed: ${detail}`
				: `auth.json was read, but its lock was lost before the read finished: ${detail}`,
			{ cause },
		);
		this.name = "AuthStoreAfterReadError";
		this.wroteBack = wroteBack;
	}
}

/** The top-level object of an auth.json document; anything else is refused rather than read as empty. */
export function parseAuthDocument(content: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(content));
	} catch {
		throw new AuthStoreUnreadableError({ kind: "malformed_json", reason: "it is not valid JSON" });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new AuthStoreUnreadableError({ kind: "invalid_format", reason: "it does not hold a JSON object" });
	}
	return parsed as Record<string, unknown>;
}

/**
 * The load error a failed store read stands for, or undefined when the failure says nothing about
 * the file: a lock held by another writer, a read the caller aborted, or a lock lost after a clean read.
 */
export function describeAuthStoreLoadFailure(error: unknown): AuthStoreLoadError | undefined {
	if (error instanceof AuthStoreUnreadableError) return error.loadError;
	if (error instanceof CredentialStoreBusyError) return undefined;
	if (error instanceof Error && error.name === "AbortError") return undefined;
	if (error instanceof AuthStoreAfterReadError) {
		if (!error.wroteBack) return undefined;
		const code = errnoCode(error.cause);
		const reason = "it was read, but its repaired or migrated copy could not be saved";
		return { kind: "write_back_failed", reason: code ? `${reason} (${code})` : reason };
	}
	const code = errnoCode(error);
	return {
		kind: "unreadable",
		reason: code ? `the file could not be read (${code})` : "the file could not be read",
	};
}

/**
 * The error a store load surfaces: once auth.json parsed, a later failure (a write-back or a lost lock)
 * becomes an AuthStoreAfterReadError so it is never reported as an unreadable file. Aborts pass through.
 */
export function failureAfterRead(error: unknown, load: { parsed: boolean; writeBack: boolean }): unknown {
	if (!load.parsed || (error instanceof Error && error.name === "AbortError")) return error;
	return new AuthStoreAfterReadError(error, load.writeBack);
}

function errnoCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
