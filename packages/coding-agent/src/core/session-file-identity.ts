import { createHash, type Hash } from "node:crypto";
import { close, fstat } from "node:fs";
import type { FileIdentity } from "./session-transcript-journal.ts";

/** Capture the owning descriptor, never a later file at its pathname. The caller keeps it open until this settles. */
export function captureFileIdentity(fd: number, path: string): Promise<FileIdentity | undefined> {
	return new Promise((resolve) => {
		fstat(fd, { bigint: true }, (error, stat) => {
			resolve(error ? undefined : { path, dev: String(stat.dev), ino: String(stat.ino) });
		});
	});
}

/** Transfer a synchronous writer/reader's descriptor to the once-per-lifecycle asynchronous capture. */
export async function captureAndCloseFileIdentity(fd: number, path: string): Promise<FileIdentity | undefined> {
	const identity = await captureFileIdentity(fd, path);
	return new Promise((resolve) => close(fd, (error) => resolve(error ? undefined : identity)));
}

/** A loader's entries and identity must come from the same descriptor, including discovery preloads. */
export const loadedFileIdentities = new WeakMap<object, Promise<FileIdentity | undefined>>();

/** The content fingerprint's own domain (RULING-72 (1)): never a catalog domain (RULING-57 (1)). */
export const BASE_CONTENT_DOMAIN = "senpi-recovery-base/1/sha256";

/**
 * A base's content fingerprint (RULING-72): SHA-256 over the domain tag, NUL, then each counted entry line (UTF-8, as
 * read; skipped blank and malformed lines excluded) and LF, fed one line at a time in the pass that reads the file.
 */
export class BaseContentHash {
	private readonly hash: Hash = createHash("sha256").update(`${BASE_CONTENT_DOMAIN}\u0000`);

	line(text: string): void {
		this.hash.update(text).update("\n");
	}

	digest(): string {
		return this.hash.digest("hex");
	}
}

/** The content fingerprint of the lines a capturing load read, or a rewrite wrote, keyed like `loadedFileIdentities`. */
export const loadedContentFingerprints = new WeakMap<object, string>();
