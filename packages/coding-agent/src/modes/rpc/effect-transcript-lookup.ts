import { type FileHandle, open } from "node:fs/promises";
import { z } from "zod";
import { CLIENT_ADMISSION_ENTRY, clientAdmissionRecordSchema } from "./client-admission-record.ts";
import { type EffectStatus, RPC_EFFECT_ENTRY, rpcEffectRecordSchema } from "./effect-record.ts";
import { projectAdmission, projectEffect } from "./effect-status.ts";

/** The first backwards pass; later chunks continue until the header, so it is never a cut-off. */
export const EFFECT_LOOKUP_CHUNK_BYTES = 4 * 1024 * 1024;

export type EffectLookup =
	| { readonly found: true; readonly effect: EffectStatus }
	| { readonly found: false; readonly searched: "complete" };

export class TranscriptUnreadable extends Error {
	readonly code = "transcript_unreadable";
	readonly path: string;
	readonly reason: string;
	readonly action = "check the sessionPath, or query the loaded session by sessionId; do not treat this as not found";

	constructor(path: string, cause: unknown) {
		const reason = `transcript_unreadable: ${cause instanceof Error ? cause.message : String(cause)}`;
		super(reason);
		this.name = "TranscriptUnreadable";
		this.path = path;
		this.reason = reason;
	}
}

const headerSchema = z.object({ type: z.literal("session"), id: z.string() });
const customEntrySchema = z.object({ type: z.literal("custom"), customType: z.string(), data: z.unknown() });
const NEWLINE = 0x0a;

/**
 * Answer `effectId` from a transcript on disk (an unloaded session), reading custom entries from the tail
 * backwards until the id is found or the header is reached. `found: false` is answered ONLY after the
 * whole file was searched; a file that cannot be read throws `TranscriptUnreadable` instead, because a
 * caller treats `found: false` as proof the effect never landed and retries it.
 */
export async function lookupEffectInTranscript(path: string, effectId: string): Promise<EffectLookup> {
	let handle: FileHandle;
	try {
		handle = await open(path, "r");
	} catch (cause) {
		throw new TranscriptUnreadable(path, cause);
	}
	try {
		const size = (await handle.stat()).size;
		const durableSessionId = await readHeaderId(handle, path, size);
		let end = size;
		let carry = Buffer.alloc(0);
		while (end > 0) {
			const start = Math.max(0, end - EFFECT_LOOKUP_CHUNK_BYTES);
			const chunk = Buffer.alloc(end - start);
			await handle.read(chunk, 0, chunk.length, start);
			const data = Buffer.concat([chunk, carry]);
			end = start;
			// Every chunk but the first in the file starts mid-line: keep that head for the next chunk.
			const firstNewline = start === 0 ? -1 : data.indexOf(NEWLINE);
			if (start > 0 && firstNewline === -1) {
				carry = data;
				continue;
			}
			carry = start === 0 ? Buffer.alloc(0) : data.subarray(0, firstNewline);
			const effect = newestInLines(data.subarray(firstNewline + 1).toString("utf8"), effectId, durableSessionId);
			if (effect) return { found: true, effect };
		}
		return { found: false, searched: "complete" };
	} catch (cause) {
		throw cause instanceof TranscriptUnreadable ? cause : new TranscriptUnreadable(path, cause);
	} finally {
		await handle.close();
	}
}

async function readHeaderId(handle: FileHandle, path: string, size: number): Promise<string> {
	const head = Buffer.alloc(Math.min(size, 64 * 1024));
	await handle.read(head, 0, head.length, 0);
	const newline = head.indexOf(NEWLINE);
	const line = head.subarray(0, newline === -1 ? head.length : newline).toString("utf8");
	const header = headerSchema.safeParse(parseJson(line));
	if (!header.success) throw new TranscriptUnreadable(path, new Error("the file has no session header"));
	return header.data.id;
}

function newestInLines(text: string, effectId: string, durableSessionId: string): EffectStatus | undefined {
	const lines = text.split("\n");
	const encodedId = JSON.stringify(effectId).slice(1, -1);
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index];
		if (!line?.includes(encodedId)) continue;
		const entry = customEntrySchema.safeParse(parseJson(line));
		if (!entry.success) continue;
		if (entry.data.customType === RPC_EFFECT_ENTRY) {
			const record = rpcEffectRecordSchema.safeParse(entry.data.data);
			if (record.success && record.data.effectId === effectId && record.data.durableSessionId === durableSessionId)
				return projectEffect(record.data);
		} else if (entry.data.customType === CLIENT_ADMISSION_ENTRY) {
			const record = clientAdmissionRecordSchema.safeParse(entry.data.data);
			if (
				record.success &&
				record.data.clientMessageId === effectId &&
				record.data.durableSessionId === durableSessionId
			)
				return projectAdmission(record.data);
		}
	}
	return undefined;
}

function parseJson(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}
