import { stripBom } from "../utils/text.ts";
import { CredentialStoreBusyError } from "./lockfile-policy.ts";

export type AuthStoreLoadErrorKind = "malformed_json" | "invalid_format" | "unreadable";

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
 * the file: a lock held by another writer, or a read the caller aborted.
 */
export function describeAuthStoreLoadFailure(error: unknown): AuthStoreLoadError | undefined {
	if (error instanceof AuthStoreUnreadableError) return error.loadError;
	if (error instanceof CredentialStoreBusyError) return undefined;
	if (error instanceof Error && error.name === "AbortError") return undefined;
	const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
	return {
		kind: "unreadable",
		reason: code ? `the file could not be opened (${code})` : "the file could not be read",
	};
}
