import { open } from "fs/promises";
import { StringDecoder } from "string_decoder";
import {
	parseRepositoryIdentity,
	REPOSITORY_IDENTITY_ENTRY_TYPE,
	type RepositoryIdentity,
} from "./repository-identity.ts";
import type { SessionHeader } from "./session-manager.ts";
import { parseEntryLine, sessionInfoName, visibleMessage } from "./session-record.ts";

/**
 * Everything a picker row needs from one session file, derived from every record
 * in the file. Exact by construction: no window, no marker heuristic, so a first
 * user message, a rename, or an out-of-order activity timestamp is found no
 * matter how deep in the transcript it sits.
 */
export type SessionSummary = {
	readonly header: SessionHeader;
	/** Latest `session_info` name anywhere in the file, including explicit clears. */
	readonly name: string | undefined;
	/** First visible user message text anywhere in the file. */
	readonly firstUserMessage: string;
	/** Count of records that parsed as `type: "message"`. */
	readonly messageCount: number;
	/** Max user/assistant activity time seen, regardless of record order. */
	readonly lastActivityTime: number | undefined;
	/** Full user/assistant transcript text in file order. */
	readonly allMessagesText: string;
	/** Latest repository identity the session recorded, so a moved repository's sessions can be found. */
	readonly repositoryIdentity?: RepositoryIdentity;
};

type SummaryAccumulator = {
	header: SessionHeader | null;
	name: string | undefined;
	firstUserMessage: string;
	messageCount: number;
	lastActivityTime: number | undefined;
	repositoryIdentity: RepositoryIdentity | undefined;
	readonly texts: string[];
};

function newAccumulator(): SummaryAccumulator {
	return {
		header: null,
		name: undefined,
		firstUserMessage: "",
		messageCount: 0,
		lastActivityTime: undefined,
		repositoryIdentity: undefined,
		texts: [],
	};
}

/**
 * Fold one JSONL line into the accumulator.
 *
 * Returns false when the file's first parsable record is not a session header,
 * which means the file is not a session and the caller stops reading.
 */
function accumulateLine(accumulator: SummaryAccumulator, line: string): boolean {
	const entry = parseEntryLine(line);
	if (!entry) return true;

	if (!accumulator.header) {
		if (entry.type !== "session" || typeof entry.id !== "string") return false;
		accumulator.header = entry;
		return true;
	}

	if (entry.type === "custom" && entry.customType === REPOSITORY_IDENTITY_ENTRY_TYPE) {
		accumulator.repositoryIdentity = parseRepositoryIdentity(entry.data) ?? accumulator.repositoryIdentity;
		return true;
	}

	const infoName = sessionInfoName(entry);
	if (infoName !== null) {
		accumulator.name = infoName;
		return true;
	}

	if (entry.type !== "message") return true;
	accumulator.messageCount++;

	const visible = visibleMessage(entry);
	if (!visible) return true;
	if (typeof visible.time === "number") {
		accumulator.lastActivityTime = Math.max(accumulator.lastActivityTime ?? 0, visible.time);
	}
	if (!visible.text) return true;
	accumulator.texts.push(visible.text);
	if (!accumulator.firstUserMessage && visible.role === "user") {
		accumulator.firstUserMessage = visible.text;
	}
	return true;
}

const LINE_READ_BUFFER_SIZE = 1024 * 1024;

/** What a completed {@link readFileLines} pass saw. */
export type FileLinesRead = {
	/** False when `onLine` stopped the pass early. */
	readonly completed: boolean;
	/** Bytes read from the file. */
	readonly bytes: number;
	/** Whether the last byte read was a newline (a torn tail has none). */
	readonly endsWithNewline: boolean;
};

/**
 * Read a file line by line through one reused 1 MiB buffer, handing each line
 * (LF-split, a trailing CR dropped) to `onLine` until it returns false.
 *
 * This replaces `readline`, whose per-line async iteration dominated summary
 * cost (senpi#2087). Only the unfinished tail of a chunk is carried between
 * reads, and the next newline search resumes where the carried tail ends, so a
 * record larger than the buffer is not rescanned per chunk. Read errors throw.
 */
export async function readFileLines(filePath: string, onLine: (line: string) => boolean): Promise<FileLinesRead> {
	const handle = await open(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(LINE_READ_BUFFER_SIZE);
		let pending = "";
		let bytes = 0;
		let lastByte = -1;
		const emit = (line: string): boolean => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);

		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			bytes += bytesRead;
			lastByte = buffer[bytesRead - 1] ?? -1;

			const searchFrom = pending.length;
			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", searchFrom);
			while (newlineIndex !== -1) {
				if (!emit(pending.slice(lineStart, newlineIndex)))
					return { completed: false, bytes, endsWithNewline: false };
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		if (pending && !emit(pending)) return { completed: false, bytes, endsWithNewline: false };
		return { completed: true, bytes, endsWithNewline: lastByte === 0x0a };
	} finally {
		await handle.close();
	}
}

/**
 * Read one session file line by line and fold it into an exact summary.
 *
 * Memory stays bounded by one read buffer plus the transcript text the summary
 * contract requires; no full-file string is ever materialized. A file whose
 * first record is not a session header, or that cannot be read, yields null.
 */
export async function readSessionSummary(filePath: string): Promise<SessionSummary | null> {
	const accumulator = newAccumulator();

	try {
		const read = await readFileLines(filePath, (line) => accumulateLine(accumulator, line));
		if (!read.completed) return null;
	} catch (error) {
		if (error instanceof Error) return null;
		throw error;
	}

	const header = accumulator.header;
	if (!header) return null;

	return {
		header,
		name: accumulator.name,
		firstUserMessage: accumulator.firstUserMessage,
		messageCount: accumulator.messageCount,
		lastActivityTime: accumulator.lastActivityTime,
		allMessagesText: accumulator.texts.join(" "),
		...(accumulator.repositoryIdentity ? { repositoryIdentity: accumulator.repositoryIdentity } : {}),
	};
}
