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
