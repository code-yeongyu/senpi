/**
 * The release's durable copy of the queued input a `move` release took out of the session (senpi#6474, senpi#3962):
 * until the export writes its manifest, the release's answer is that input's only other copy, and an answer the
 * caller never received, or an export that fails before its manifest, would leave `finish` nothing to re-queue. The
 * record lives beside the move's staged extension state, so the move's own lifetime bounds it: a later release
 * attempt of the same move overwrites it with what it took, and `finish` removes it with the rest of the move's
 * files once the input is back under its per-move client message ids.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { droppedInputRecordPath } from "./extension-state.ts";
import type { MoveId } from "./ownership.ts";

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

/** Records the queued input the release is about to answer, before the answer can leave. */
export async function writeDroppedInputRecord(
	sessionFile: string,
	moveId: MoveId,
	texts: readonly string[],
): Promise<void> {
	const staging = `${droppedInputRecordPath(sessionFile, moveId)}.partial-${process.pid}`;
	await writeFile(staging, `${JSON.stringify({ format: FORMAT, moveId, userMessages: texts }, null, 1)}\n`);
	await rename(staging, droppedInputRecordPath(sessionFile, moveId));
}

/**
 * The queued input recorded for `moveId`, in order: nothing when the move's release recorded none. A record that
 * exists but cannot be read refuses the caller (the input it names is owed, so losing it silently is not an option).
 */
export async function readDroppedInputRecord(sessionFile: string, moveId: MoveId): Promise<readonly string[]> {
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
	const messages: unknown = Reflect.get(raw, "userMessages");
	if (!Array.isArray(messages) || !messages.every((message) => typeof message === "string"))
		throw unreadable("malformed queued input");
	return messages;
}
