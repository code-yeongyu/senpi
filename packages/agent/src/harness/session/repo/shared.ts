import { randomBytes } from "node:crypto";
import type { SessionMetadata, SessionStorage, SessionTreeEntry } from "../../types.js";
import { Session } from "../session.js";

function uuidv7(): string {
	const timestamp = BigInt(Date.now());
	const bytes = randomBytes(10);
	const hex = [
		((timestamp >> 40n) & 0xffn).toString(16).padStart(2, "0"),
		((timestamp >> 32n) & 0xffn).toString(16).padStart(2, "0"),
		((timestamp >> 24n) & 0xffn).toString(16).padStart(2, "0"),
		((timestamp >> 16n) & 0xffn).toString(16).padStart(2, "0"),
		((timestamp >> 8n) & 0xffn).toString(16).padStart(2, "0"),
		(timestamp & 0xffn).toString(16).padStart(2, "0"),
		(0x70 | (bytes[0]! & 0x0f)).toString(16).padStart(2, "0"),
		bytes[1]!.toString(16).padStart(2, "0"),
		(0x80 | (bytes[2]! & 0x3f)).toString(16).padStart(2, "0"),
		bytes[3]!.toString(16).padStart(2, "0"),
		...Array.from(bytes.slice(4), (byte) => byte.toString(16).padStart(2, "0")),
	].join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function createSessionId(): string {
	return uuidv7();
}

export function createTimestamp(): string {
	return new Date().toISOString();
}

export function toSession<TMetadata extends SessionMetadata>(storage: SessionStorage<TMetadata>): Session<TMetadata> {
	return new Session(storage);
}

export async function getEntriesToFork(
	storage: SessionStorage,
	options: { entryId?: string; position?: "before" | "at" },
): Promise<SessionTreeEntry[]> {
	if (!options.entryId) return storage.getEntries();
	const target = await storage.getEntry(options.entryId);
	if (!target) {
		throw new Error(`Entry ${options.entryId} not found`);
	}
	let effectiveLeafId: string | null;
	if ((options.position ?? "before") === "at") {
		effectiveLeafId = target.id;
	} else {
		if (target.type !== "message" || target.message.role !== "user") {
			throw new Error(`Entry ${options.entryId} is not a user message`);
		}
		effectiveLeafId = target.parentId;
	}
	return storage.getPathToRoot(effectiveLeafId);
}
