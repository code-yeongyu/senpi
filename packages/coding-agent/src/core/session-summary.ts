import { createReadStream } from "fs";
import { createInterface } from "readline";
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
};

type SummaryAccumulator = {
	header: SessionHeader | null;
	name: string | undefined;
	firstUserMessage: string;
	messageCount: number;
	lastActivityTime: number | undefined;
	readonly texts: string[];
};

function newAccumulator(): SummaryAccumulator {
	return {
		header: null,
		name: undefined,
		firstUserMessage: "",
		messageCount: 0,
		lastActivityTime: undefined,
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

/**
 * Stream one session file line by line and fold it into an exact summary.
 *
 * Memory stays bounded by readline's buffer plus the transcript text the summary
 * contract requires; no full-file string is ever materialized. A file whose
 * first record is not a session header, or that cannot be read, yields null.
 */
export async function readSessionSummary(filePath: string): Promise<SessionSummary | null> {
	const accumulator = newAccumulator();
	const stream = createReadStream(filePath, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

	try {
		for await (const line of lines) {
			if (!accumulateLine(accumulator, line)) return null;
		}
	} catch (error) {
		if (error instanceof Error) return null;
		throw error;
	} finally {
		lines.close();
		stream.destroy();
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
	};
}
