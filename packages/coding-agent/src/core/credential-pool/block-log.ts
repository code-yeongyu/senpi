import { appendFile, chmod, rename, stat } from "node:fs/promises";
import { redactSecrets } from "../sensitive-output.ts";
import type { CredentialBlock, RateLimitResetSource } from "./classify.ts";

/**
 * A local record of why the pool blocked a slot (senpi#3216): the classified reason, where the reset came from,
 * and a redacted excerpt of the provider's answer, so a support question about a long block can be answered from
 * the machine. One JSON line per block, next to the pool state file, never holding tokens or account ids.
 */
export type CredentialBlockLogEntry = {
	readonly at: string;
	readonly provider: string;
	/** The slot's local name in the pool (`default`, `login-2`), not a provider account id. */
	readonly slot: string;
	readonly reason: CredentialBlock["reason"];
	readonly blockedUntil?: string;
	readonly resetSource?: RateLimitResetSource;
	/** The model family a model-scoped limit binds; absent for a block on the whole account. */
	readonly model?: string;
	readonly excerpt?: string;
};

/** The log rolls over to one `.1` generation past this size, so it stays bounded on a busy machine. */
export const BLOCK_LOG_MAX_BYTES = 256 * 1024;
const EXCERPT_MAX_CHARS = 240;

// Account identifiers a provider message can carry: e-mail addresses, UUIDs, and prefixed ids
// (`user-…`, `org-…`, `acct_…`, `account_…`). Credential shapes are handled by redactSecrets.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PREFIXED_ID = /\b(?:user|org|acct|account|ws|workspace)[-_][A-Za-z0-9]{6,}\b/gi;

export function redactBlockExcerpt(text: string): string {
	const masked = redactSecrets(text)
		.replace(EMAIL, "[EMAIL]")
		.replace(UUID, "[ID]")
		.replace(PREFIXED_ID, "[ID]")
		.replace(/\s+/g, " ")
		.trim();
	return masked.length > EXCERPT_MAX_CHARS ? `${masked.slice(0, EXCERPT_MAX_CHARS)}…` : masked;
}

// One write chain per log path: appends run in the order the blocks happened, and the size check and rollover of
// one append cannot interleave with the next.
const pendingWrites = new Map<string, Promise<void>>();

/**
 * Appends one entry without blocking the caller (the block is recorded on the session path, which must not run
 * synchronous fs work: senpi#3993). A log that cannot be written never fails the request that was blocked.
 */
export function appendCredentialBlockLog(path: string, entry: CredentialBlockLogEntry): void {
	const previous = pendingWrites.get(path) ?? Promise.resolve();
	const next = previous.then(() => writeEntry(path, entry));
	pendingWrites.set(path, next);
	void next.finally(() => {
		if (pendingWrites.get(path) === next) pendingWrites.delete(path);
	});
}

/** Resolves once every entry appended to `path` so far is on disk (or was dropped as unwritable). */
export function flushCredentialBlockLog(path: string): Promise<void> {
	return pendingWrites.get(path) ?? Promise.resolve();
}

async function writeEntry(path: string, entry: CredentialBlockLogEntry): Promise<void> {
	try {
		const size = await fileSize(path);
		if (size !== undefined && size >= BLOCK_LOG_MAX_BYTES) await rename(path, `${path}.1`);
		await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		await chmod(path, 0o600);
	} catch {
		// Best effort: the block itself is already recorded in the pool state.
	}
}

async function fileSize(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).size;
	} catch {
		return undefined;
	}
}
