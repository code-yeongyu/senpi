import type { Message, TextContent } from "@earendil-works/pi-ai";
import type { FileEntry } from "./session-manager.ts";

/** A user/assistant message's visible text and activity time. */
export type VisibleMessage = {
	readonly text: string;
	readonly role: "user" | "assistant";
	readonly time: number | undefined;
};

/** Deserialize one JSONL line. Malformed lines are skipped, matching full-file session loading. */
export function parseEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		return null;
	}
}

function isMessageWithContent(message: unknown): message is Message {
	return (
		typeof message === "object" &&
		message !== null &&
		typeof (message as { role?: unknown }).role === "string" &&
		"content" in message
	);
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

/** The record's visible message, or null when it is not a user/assistant message. */
export function visibleMessage(entry: FileEntry): VisibleMessage | null {
	if (entry.type !== "message") return null;
	const message = entry.message;
	if (!isMessageWithContent(message)) return null;
	if (message.role !== "user" && message.role !== "assistant") return null;
	const messageTime = (message as { timestamp?: number }).timestamp;
	const entryTime = Date.parse(entry.timestamp);
	const time = typeof messageTime === "number" ? messageTime : Number.isNaN(entryTime) ? undefined : entryTime;
	return { text: extractTextContent(message), role: message.role, time };
}

/** The record's display name, or null when the record is not a session_info entry. */
export function sessionInfoName(entry: FileEntry): string | undefined | null {
	if (entry.type !== "session_info") return null;
	return entry.name?.trim() || undefined;
}
