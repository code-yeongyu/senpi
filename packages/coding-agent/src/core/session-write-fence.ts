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

/**
 * The fence only Node developer-hatch writers check (K9-F2, senpi#5822). The durable store advances it to stop a hatch
 * writer without touching a Bun co-holder, which checks only the takeover fence above.
 */
export function sessionHatchFenceFile(sessionFile: string): string {
	return `${sessionFile}.hatch-fence`;
}

function readToken(file: string): string {
	try {
		return readFileSync(file, "utf8").trim();
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw cause;
	}
}

/** The fence token now on disk; empty when the file was never taken over. Any other read failure throws. */
export function readSessionFence(sessionFile: string): string {
	return readToken(sessionFenceFile(sessionFile));
}

/** Gives the file a new token, so every writer that opened it before this call refuses its next write. */
export async function advanceSessionFence(sessionFile: string): Promise<void> {
	await replaceToken(sessionFenceFile(sessionFile));
}

/** Gives the hatch fence a new token, so every hatch writer that opened the file before this call refuses its next write. */
export async function advanceHatchFence(sessionFile: string): Promise<void> {
	await replaceToken(sessionHatchFenceFile(sessionFile));
}

async function replaceToken(file: string): Promise<void> {
	const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		await writeFile(temporary, `${randomUUID()}\n`, { mode: 0o600 });
		await rename(temporary, file);
	} catch (cause) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw cause;
	}
}

/**
 * One writer's view of its file's fence: the token seen when the file was opened, re-checked before every write. A hatch
 * writer (`isHatchWriter()` true) also checks the hatch fence.
 */
export class SessionWriteFence {
	private seen: { readonly file: string; readonly token: string } | undefined;
	private fencedFile: string | undefined;

	private readonly isHatchWriter: () => boolean;

	constructor(isHatchWriter: () => boolean = () => false) {
		this.isHatchWriter = isHatchWriter;
	}

	private token(sessionFile: string): string {
		const takeover = readSessionFence(sessionFile);
		return this.isHatchWriter() ? `${takeover}\n${readToken(sessionHatchFenceFile(sessionFile))}` : takeover;
	}

	opened(sessionFile: string): void {
		if (this.fencedFile !== sessionFile) this.fencedFile = undefined;
		this.seen = { file: sessionFile, token: this.token(sessionFile) };
	}

	assertOwned(sessionFile: string): void {
		if (this.fencedFile === sessionFile) throw new SessionFencedError(sessionFile);
		// A file this writer starts itself (a new session, a fork) has no earlier owner to fence out.
		if (this.seen?.file !== sessionFile) {
			this.opened(sessionFile);
			return;
		}
		if (this.token(sessionFile) === this.seen.token) return;
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
