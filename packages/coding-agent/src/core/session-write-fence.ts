/**
 * The write fence of one session file (senpi#3652).
 *
 * A host may take a session file over from another generation whose claim it could not prove alive, for example a
 * Windows generation that stopped heartbeating while an unrelated process wears its recycled pid. That verdict can be
 * wrong: a generation whose event loop froze, or whose machine slept, also stops heartbeating, and it would resume
 * writing the same file. The fence makes that second writer impossible instead of unlikely. A takeover replaces the
 * token in `<session file>.fence` before the new owner opens the file; every writer remembers the token it saw when it
 * opened the file and re-reads it, synchronously, right before each write. A writer that finds another token refuses
 * the write and every later one: the file is no longer its own.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";

export function sessionFenceFile(sessionFile: string): string {
	return `${sessionFile}.fence`;
}

/** The fence token now on disk; empty when the file was never taken over. Any other read failure throws. */
export function readSessionFence(sessionFile: string): string {
	try {
		return readFileSync(sessionFenceFile(sessionFile), "utf8").trim();
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw cause;
	}
}

/** Gives the file a new token, so every writer that opened it before this call refuses its next write. */
export async function advanceSessionFence(sessionFile: string): Promise<void> {
	const file = sessionFenceFile(sessionFile);
	const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		await writeFile(temporary, `${randomUUID()}\n`, { mode: 0o600 });
		await rename(temporary, file);
	} catch (cause) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw cause;
	}
}

/** One writer's view of its file's fence: the token seen when the file was opened, re-checked before every write. */
export class SessionWriteFence {
	private seen: { readonly file: string; readonly token: string } | undefined;
	private fencedFile: string | undefined;

	opened(sessionFile: string): void {
		if (this.fencedFile !== sessionFile) this.fencedFile = undefined;
		this.seen = { file: sessionFile, token: readSessionFence(sessionFile) };
	}

	assertOwned(sessionFile: string): void {
		if (this.fencedFile === sessionFile) throw new SessionFencedError(sessionFile);
		// A file this writer starts itself (a new session, a fork) has no earlier owner to fence out.
		if (this.seen?.file !== sessionFile) {
			this.opened(sessionFile);
			return;
		}
		if (readSessionFence(sessionFile) === this.seen.token) return;
		this.fencedFile = sessionFile;
		throw new SessionFencedError(sessionFile);
	}
}

export class SessionFencedError extends Error {
	readonly code = "session_fenced";
	readonly sessionFile: string;

	constructor(sessionFile: string) {
		super(
			`${sessionFile} was taken over by another host generation; this writer no longer owns it and will not write to it`,
		);
		this.name = "SessionFencedError";
		this.sessionFile = sessionFile;
	}
}
