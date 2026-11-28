/**
 * The release's durable copy of the queued input a `move` release took out of the session (senpi#6474, senpi#3962):
 * until the export writes its manifest, the release's answer is that input's only other copy, and an answer the
 * caller never received, or an export that fails before its manifest, would leave `finish` nothing to re-queue.
 *
 * The record belongs to one session file and one release attempt. It is written before the seal, under the attempt the
 * release is about to seal, and counts only while that session's own `session_released` entry for the move names that
 * attempt. A release refused before its seal hands the input back in its refusal, and the record it may have written
 * names an attempt no seal names, so the input has exactly one owner whichever way the release ends.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { loadEntriesFromFileAsync } from "../session-manager.ts";
import { parseMoveId } from "./bundle.ts";
import { MOVE_STATE, sealedAttempt } from "./extension-state.ts";
import { headerSessionId, type MoveId } from "./ownership.ts";

const FORMAT = 1;

export class DroppedInputRecordError extends Error {
	readonly code = "dropped_input_record_invalid";

	constructor(detail: string) {
		super(`The record of the queued input this move took out is unreadable (${detail}); it was not re-queued.`);
		this.name = "DroppedInputRecordError";
	}
}

const unreadable = (error: unknown) =>
	new DroppedInputRecordError(error instanceof Error ? error.message : String(error));

/** The release attempt that writes a record, and the session it took the input from. */
export interface DroppedInputOwner {
	readonly sessionId: string;
	readonly attempt: string;
}

export function droppedInputRecordPath(sessionFile: string, moveId: MoveId): string {
	return join(
		dirname(sessionFile),
		MOVE_STATE,
		"dropped",
		`${basename(sessionFile, ".jsonl")}.${parseMoveId(moveId)}.json`,
	);
}

/** Records the queued input the release is about to answer, before the answer can leave. */
export async function writeDroppedInputRecord(
	sessionFile: string,
	moveId: MoveId,
	owner: DroppedInputOwner,
	texts: readonly string[],
): Promise<void> {
	const target = droppedInputRecordPath(sessionFile, moveId);
	const staging = `${target}.partial-${process.pid}`;
	await mkdir(dirname(target), { recursive: true });
	try {
		await writeFile(
			staging,
			`${JSON.stringify({ format: FORMAT, moveId, ...owner, userMessages: texts }, null, 1)}\n`,
		);
		await rename(staging, target);
	} catch (error) {
		await rm(staging, { force: true });
		throw error;
	}
}

/**
 * The queued input this session's sealed release of `moveId` recorded, in order: nothing when no seal names the
 * attempt that wrote the record. A record that is owed but cannot be read refuses the caller, since losing it
 * silently is not an option.
 */
export async function readDroppedInputRecord(sessionFile: string, moveId: MoveId): Promise<readonly string[]> {
	const entries = await loadEntriesFromFileAsync(sessionFile);
	const sessionId = headerSessionId(entries);
	const attempt = sealedAttempt(entries, moveId);
	if (sessionId === undefined || attempt === undefined) return [];
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(droppedInputRecordPath(sessionFile, moveId), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw unreadable(error);
	}
	if (typeof raw !== "object" || raw === null) throw unreadable("the record is not an object");
	const format: unknown = Reflect.get(raw, "format");
	if (format !== FORMAT) throw unreadable(`unknown record format ${String(format)}`);
	// Written by a release this session's seal does not name (one refused before its seal), or for another session.
	if (Reflect.get(raw, "sessionId") !== sessionId || Reflect.get(raw, "attempt") !== attempt) return [];
	const messages: unknown = Reflect.get(raw, "userMessages");
	if (!Array.isArray(messages) || !messages.every((message) => typeof message === "string"))
		throw unreadable("malformed queued input");
	return messages;
}

export async function removeDroppedInputRecord(sessionFile: string, moveId: MoveId): Promise<void> {
	await rm(droppedInputRecordPath(sessionFile, moveId), { force: true });
}
