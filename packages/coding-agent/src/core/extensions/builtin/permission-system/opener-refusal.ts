import { createReadStream, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { fsJournalDurability } from "../../../pending-input-journal.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { REFUSE_APPROVALS_ENTRY_TYPE } from "./non-interactive.ts";

type Session = ExtensionContext["sessionManager"];

/**
 * Whether the session refuses every ask because its opener declared nobody answers (oh-my-openagent#14649). A labelled
 * open records the refusal in the session file, bound to the session id, so a later open of that file without the label
 * (a wake after the process died, a handover, a reopen by path) keeps refusing. A fork copies the entry under a new
 * session id, so it does not match there: the fork refuses only when its own opener labels it.
 */
export async function openerRefuses(pi: ExtensionAPI, session: Session, labelled: boolean): Promise<boolean> {
	const sessionId = session.getSessionId();
	const recorded = await hasRefusalRecord(session, sessionId);
	if (labelled && !recorded) await recordRefusal(pi, session, sessionId);
	return labelled || recorded;
}

/**
 * The record is written at the first labelled start, before the first message, so only the entries ahead of the first
 * message are read: a session on disk is streamed up to that line, never loaded whole. A session with no file yet holds
 * only those leading entries in memory. A session first labelled after it already had messages records the refusal
 * behind them, where this does not look; it refuses on every labelled open, and each such open records it again.
 */
async function hasRefusalRecord(session: Session, sessionId: string): Promise<boolean> {
	const file = session.getSessionFile();
	if (file !== undefined && existsSync(file)) return leadingRecordInFile(file, sessionId);
	for (const entry of session.getEntries()) {
		if (entry.type === "message") return false;
		if (entry.type === "custom" && isRecordFor(entry, sessionId)) return true;
	}
	return false;
}

async function leadingRecordInFile(file: string, sessionId: string): Promise<boolean> {
	const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			const names = line.includes(REFUSE_APPROVALS_ENTRY_TYPE);
			if (!names && !line.includes('"type":"message"')) continue;
			const entry = parseLine(line);
			if (entry?.type === "message") return false;
			if (names && entry?.type === "custom" && isRecordFor(entry, sessionId)) return true;
		}
		return false;
	} finally {
		lines.close();
	}
}

/** The session loader skips a line that does not parse (a torn tail), so this reader skips it too. */
function parseLine(line: string): { type?: unknown; customType?: unknown; data?: unknown } | undefined {
	try {
		return JSON.parse(line) as { type?: unknown; customType?: unknown; data?: unknown };
	} catch {
		return undefined;
	}
}

function isRecordFor(entry: { customType?: unknown; data?: unknown }, sessionId: string): boolean {
	if (entry.customType !== REFUSE_APPROVALS_ENTRY_TYPE) return false;
	const data = entry.data as { sessionId?: unknown } | undefined;
	return data?.sessionId === sessionId;
}

/**
 * The record is on disk and synced before the session starts: the header is forced so the entry goes to the file
 * itself (not the buffer that waits for the first message), then the file and its directory are synced. A session
 * opened without persistence has no file and keeps the record in memory, like the rest of that session.
 */
async function recordRefusal(pi: ExtensionAPI, session: Session, sessionId: string): Promise<void> {
	await pi.session.persistHeaderNow();
	pi.appendEntry(REFUSE_APPROVALS_ENTRY_TYPE, { sessionId });
	const file = session.getSessionFile();
	if (file === undefined || !existsSync(file)) return;
	const durability = fsJournalDurability();
	await durability.syncFile(file);
	await durability.syncDirectory(dirname(file));
}
