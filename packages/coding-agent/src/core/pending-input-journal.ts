import { type FileHandle, open } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
	PENDING_INPUT_TRANSITION,
	type PendingInputJournal,
	type PendingInputJournalRecord,
} from "./pending-input-store.ts";
import type { PendingInput, PendingInputOperationResult } from "./pending-input-types.ts";
import type { SessionManager } from "./session-manager.ts";

type JournalSession = Pick<
	SessionManager,
	"appendCustomEntry" | "persistHeaderNow" | "getEntries" | "getSessionFile" | "isPersisted" | "isTranscriptFlushed"
>;

/** How the journal makes an append durable: the file's data, and once the directory entry that names it. */
export interface JournalDurability {
	syncFile(path: string): Promise<void>;
	syncDirectory(path: string): Promise<void>;
}

export type JournalFileOpener = (path: string, flags: "r" | "r+") => Promise<Pick<FileHandle, "sync" | "close">>;

/**
 * Windows flushes only through a handle with write access (FlushFileBuffers on a read-only handle fails with EPERM,
 * senpi#3866), so the file is synced through an `r+` handle. A directory cannot be opened for writing anywhere, and
 * on Windows a directory handle cannot be flushed at all, so the directory sync is skipped there.
 */
export function fsJournalDurability(
	platform: NodeJS.Platform = process.platform,
	openFile: JournalFileOpener = open,
): JournalDurability {
	return {
		syncFile: (path) => syncPath(openFile, path, "r+"),
		syncDirectory: (path) => (platform === "win32" ? Promise.resolve() : syncPath(openFile, path, "r")),
	};
}

/**
 * The session JSONL as the pending-input journal (senpi#3549): each transition is one `custom` entry,
 * on disk and synced before the store publishes or dispatches it, even before the session's first message.
 */
export class SessionPendingInputJournal implements PendingInputJournal {
	private readonly session: JournalSession;
	private readonly durability: JournalDurability;
	private directorySynced = false;

	constructor(session: JournalSession, durability: JournalDurability = fsJournalDurability()) {
		this.session = session;
		this.durability = durability;
	}

	/**
	 * A session opened without persistence (--no-session) keeps the journal in memory only, like the rest of
	 * that session. A persisted session must have its file on disk before the entry counts: the header is
	 * forced, the entry must reach the file itself (not the pre-conversation buffer), and the file and, once,
	 * its directory are synced before this returns.
	 */
	async append(record: PendingInputJournalRecord): Promise<void> {
		if (!this.session.isPersisted()) {
			this.session.appendCustomEntry(PENDING_INPUT_TRANSITION, record);
			return;
		}
		await this.session.persistHeaderNow();
		const file = this.session.getSessionFile();
		if (file === undefined || !this.session.isTranscriptFlushed()) throw new PendingInputNotDurableError();
		this.session.appendCustomEntry(PENDING_INPUT_TRANSITION, record);
		// From here the entry is in the file: a failure can no longer be undone, only reported as uncertain.
		try {
			await this.durability.syncFile(file);
			if (!this.directorySynced) {
				await this.durability.syncDirectory(dirname(file));
				this.directorySynced = true;
			}
		} catch (error) {
			throw new PendingInputAppendUncertainError(record.cursor, file, error);
		}
	}

	async read(): Promise<readonly PendingInputJournalRecord[]> {
		const records = (await this.transitionEntries()).map((entry) => parseRecord(entry.data, entry.id));
		records.sort((a, b) => a.cursor - b.cursor);
		// The session loader skips a line that does not parse, so a lost transition shows only as a cursor gap.
		records.forEach((record, index) => {
			if (record.cursor !== index + 1) throw new PendingInputJournalGapError(index + 1);
		});
		return records;
	}

	/**
	 * A persisted session's transitions come from one streaming pass over its file, never from `getEntries()`:
	 * on a trimmed session that would materialize and keep the whole history (senpi#3519, #3535). An in-memory
	 * session has no file, so its entries are the journal.
	 */
	private async transitionEntries(): Promise<readonly TransitionEntry[]> {
		// A session whose file is not written yet (a branch with no message so far) holds its transitions only in
		// memory; it was never trimmed, so reading its entries costs nothing (#3586 review H1).
		const file =
			this.session.isPersisted() && this.session.isTranscriptFlushed() ? this.session.getSessionFile() : undefined;
		if (file === undefined)
			return this.session
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === PENDING_INPUT_TRANSITION
						? [{ data: entry.data, id: entry.id }]
						: [],
				);
		return scanTransitions(file).catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
			throw error;
		});
	}
}

interface TransitionEntry {
	readonly data: unknown;
	readonly id: string;
}

/**
 * The session loader skips a line that does not parse, so a corrupt transition would vanish with no cursor gap.
 * A line that ends in a newline was written completely: if it names a transition and does not parse, it is
 * corrupt and refused, the last line included. A final segment with no newline is a tail torn by a crash: it was
 * never committed, the loader drops it, and the next append cuts it back, so it is tolerated. A torn line keeps
 * its prefix, and `appendCustomEntry` writes `type` and `customType` first, so the marker survives a tear.
 * Only lines naming a transition are parsed, so the pass holds one line at a time, never the transcript.
 */
async function scanTransitions(file: string): Promise<TransitionEntry[]> {
	const handle = await open(file, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		const entries: TransitionEntry[] = [];
		let pending = "";
		let lineNumber = 0;
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			pending += decoder.write(buffer.subarray(0, bytesRead));
			let start = 0;
			let newline = pending.indexOf("\n", start);
			while (newline !== -1) {
				lineNumber += 1;
				const entry = transitionOf(pending.slice(start, newline), lineNumber);
				if (entry !== undefined) entries.push(entry);
				start = newline + 1;
				newline = pending.indexOf("\n", start);
			}
			pending = pending.slice(start);
		}
		// After the last newline is the torn tail of a crash, or nothing. A final line that parses was written whole
		// (a writer outside senpi that omits the newline); the loader keeps it, so it is read too (#3586 review L1).
		const tail = finalSegmentTransition(pending, lineNumber + 1);
		if (tail !== undefined) entries.push(tail);
		return entries;
	} finally {
		await handle.close();
	}
}

function finalSegmentTransition(segment: string, lineNumber: number): TransitionEntry | undefined {
	if (!segment.includes(PENDING_INPUT_TRANSITION)) return undefined;
	try {
		JSON.parse(segment);
	} catch {
		return undefined;
	}
	return transitionOf(segment, lineNumber);
}

function transitionOf(line: string, lineNumber: number): TransitionEntry | undefined {
	if (!line.includes(PENDING_INPUT_TRANSITION)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new PendingInputJournalCorruptError(lineNumber);
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("type" in parsed && parsed.type === "custom") ||
		!("customType" in parsed && parsed.customType === PENDING_INPUT_TRANSITION)
	)
		return undefined;
	return { data: "data" in parsed ? parsed.data : undefined, id: "id" in parsed ? String(parsed.id) : "" };
}

export class PendingInputJournalCorruptError extends Error {
	readonly code = "pending_input_journal_corrupt";
	constructor(lineNumber: number) {
		super(`Pending input journal line ${lineNumber} is corrupt; the session cannot recover its queued input safely.`);
		this.name = "PendingInputJournalCorruptError";
	}
}

/** The entry reached the file but could not be synced: it may or may not survive a crash. */
export class PendingInputAppendUncertainError extends Error {
	readonly code = "pending_input_append_uncertain";
	constructor(cursor: number, file: string, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(
			`Pending input transition ${cursor} was written to ${file} but could not be synced (${reason}). This is a local file error, not a model error; reopen the session to recover.`,
			{ cause },
		);
		this.name = "PendingInputAppendUncertainError";
	}
}

export class PendingInputNotDurableError extends Error {
	readonly code = "pending_input_journal_not_durable";
	constructor() {
		super("The session file is not on disk yet, so a pending input cannot be saved; try again.");
		this.name = "PendingInputNotDurableError";
	}
}

export class PendingInputJournalGapError extends Error {
	readonly code = "pending_input_journal_gap";
	constructor(missingCursor: number) {
		super(
			`Pending input journal is missing transition ${missingCursor}; the session cannot recover its queued input safely.`,
		);
		this.name = "PendingInputJournalGapError";
	}
}

async function syncPath(openFile: JournalFileOpener, path: string, flags: "r" | "r+"): Promise<void> {
	const handle = await openFile(path, flags);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export class PendingInputJournalError extends Error {
	readonly code = "pending_input_journal_invalid";
	constructor(entryId: string) {
		super(`Pending input journal entry ${entryId} is malformed; the session cannot recover its queued input safely.`);
		this.name = "PendingInputJournalError";
	}
}

function parseRecord(data: unknown, entryId: string): PendingInputJournalRecord {
	if (
		typeof data !== "object" ||
		data === null ||
		!("type" in data && data.type === PENDING_INPUT_TRANSITION) ||
		!("cursor" in data && typeof data.cursor === "number") ||
		!("input" in data && isPendingInput(data.input))
	) {
		throw new PendingInputJournalError(entryId);
	}
	const result = "result" in data ? data.result : undefined;
	if (result !== undefined && !isOperationResult(result)) throw new PendingInputJournalError(entryId);
	const batch = "batch" in data ? data.batch : undefined;
	if (batch !== undefined && !(Array.isArray(batch) && batch.every(isPendingInput)))
		throw new PendingInputJournalError(entryId);
	return {
		type: PENDING_INPUT_TRANSITION,
		cursor: data.cursor,
		input: data.input,
		...(result === undefined ? {} : { result }),
		...(batch === undefined ? {} : { batch }),
	};
}

function isOperationResult(value: unknown): value is PendingInputOperationResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"outcome" in value &&
		typeof value.outcome === "string" &&
		"clientMessageId" in value &&
		typeof value.clientMessageId === "string"
	);
}

function isPendingInput(value: unknown): value is PendingInput {
	return (
		typeof value === "object" &&
		value !== null &&
		"clientMessageId" in value &&
		typeof value.clientMessageId === "string" &&
		"phase" in value &&
		typeof value.phase === "string" &&
		"handle" in value &&
		typeof value.handle === "object" &&
		"revision" in value &&
		typeof value.revision === "number"
	);
}
