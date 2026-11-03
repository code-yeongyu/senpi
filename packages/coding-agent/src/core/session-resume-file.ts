import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseSessionEntryLine, type ResumeFileTail, SessionLineSplitter } from "./session-entry-file.ts";
import { BaseContentHash, captureFileIdentity } from "./session-file-identity.ts";
import type { FileIdentity } from "./session-transcript-journal.ts";
import { recoveryNotice, type SessionRecovery } from "./session-write-recovery.ts";

function errno(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Resolve missing destinations through their existing parent, without guessing on permission failures. */
export async function resumeCanonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if (errno(error) !== "ENOENT") throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return join(await resumeCanonicalPath(parent), basename(path));
	}
}

/** Bounded asynchronous exact-byte fingerprint, independent of parsed-entry normalization. */
export async function readResumeFingerprint(path: string): Promise<string | undefined> {
	let handle: FileHandle;
	try {
		handle = await open(path, "r");
	} catch (error) {
		if (errno(error) === "ENOENT") return undefined;
		throw error;
	}
	try {
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) return hash.digest("hex");
			hash.update(buffer.subarray(0, bytesRead));
		}
	} finally {
		await handle.close();
	}
}

async function* resumeFileChunks(path: string, start = 0, end = Number.POSITIVE_INFINITY): AsyncGenerator<Uint8Array> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let offset = start;
		while (offset < end) {
			const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - offset), offset);
			if (bytesRead === 0) break;
			yield buffer.subarray(0, bytesRead);
			offset += bytesRead;
		}
	} finally {
		await handle.close();
	}
}

/** Keep existing committed bytes verbatim, terminating a valid final record before appending. */
export async function* appendResumeEntries(
	path: string,
	entries: Iterable<string>,
	end?: number,
): AsyncGenerator<string | Uint8Array> {
	let last: number | undefined;
	for await (const chunk of resumeFileChunks(path, 0, end)) {
		last = chunk[chunk.length - 1];
		yield chunk;
	}
	if (last !== undefined && last !== 10) yield "\n";
	yield* entries;
}

/** Preserve an incomplete tail before the accepted publication removes it. */
export async function backupResumeTail(
	path: string,
	tail: ResumeFileTail,
	revalidate: () => Promise<void>,
	validate: () => void,
): Promise<SessionRecovery> {
	const backupPath = `${path}.torn-${Date.now()}-${randomUUID().slice(0, 8)}`;
	await replaceResumeFile(backupPath, resumeFileChunks(path, tail.start, tail.size), {
		captureContent: false,
		revalidate,
		validate,
		published: () => {},
	});
	return {
		cause: "unknown",
		backupPath,
		droppedBytes: tail.size - tail.start,
		notice: recoveryNotice("unknown", backupPath),
	};
}

/**
 * Strict publication: the old file is untouched until rename, with no in-place fallback.
 * The caller holds the host grant and excludes synchronous local writers across every await.
 */
export async function replaceResumeFile(
	path: string,
	chunks: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>,
	publication: {
		readonly captureContent: boolean;
		readonly revalidate: () => Promise<void>;
		readonly validate: () => void;
		readonly published: (identity: Promise<FileIdentity | undefined>, contentFingerprint?: string) => void;
	},
): Promise<void> {
	let mode: number | undefined;
	try {
		mode = (await stat(path)).mode & 0o7777;
	} catch (error) {
		if (errno(error) !== "ENOENT") throw error;
	}
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	const handle = await open(temporary, "wx", mode ?? 0o600);
	const content = publication.captureContent ? new BaseContentHash() : undefined;
	const lines = content ? new SessionLineSplitter() : undefined;
	let published = false;
	try {
		let identity: Promise<FileIdentity | undefined>;
		try {
			if (mode !== undefined) await handle.chmod(mode);
			for await (const chunk of chunks) {
				if (lines) {
					const buffer =
						typeof chunk === "string"
							? Buffer.from(chunk)
							: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
					for (const line of lines.push(buffer)) {
						if (parseSessionEntryLine(line)) content?.line(line);
					}
				}
				await handle.writeFile(chunk);
			}
			const finalLine = lines?.finish();
			if (finalLine && parseSessionEntryLine(finalLine)) content?.line(finalLine);
			await handle.sync();
			identity = captureFileIdentity(handle.fd, path);
			await identity;
		} finally {
			await handle.close();
		}
		await publication.revalidate();
		publication.validate();
		await rename(temporary, path);
		published = true;
		publication.published(identity, content?.digest());
		if (process.platform !== "win32") {
			const directory = await open(dirname(path), "r");
			try {
				await directory.sync();
			} catch (error) {
				const code = errno(error);
				if (code === undefined || !["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR"].includes(code)) throw error;
			} finally {
				await directory.close();
			}
		}
	} catch (error) {
		if (!published) {
			try {
				await rm(temporary, { force: true });
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "resume publication and temporary cleanup failed");
			}
		}
		throw error;
	}
}
