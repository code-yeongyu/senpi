import { afterEach, beforeEach } from "vitest";
import type { AssistantMessage, AssistantMessageEvent } from "../src/types.ts";
import {
	type AssistantProgress,
	type AssistantRecord,
	assistantRecords,
	getAssistantCapture,
	isAssistantProgress,
	subscribeAssistantCapture,
} from "../src/utils/assistant-capture.ts";
import type { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

/** Holds a capture subscription around each test of the calling file, as an internal agent listener does. */
export function subscribeCaptureForEachTest(): void {
	let release = () => {};
	beforeEach(() => {
		release = subscribeAssistantCapture();
	});
	afterEach(() => release());
}

/** Settles first: every start and delta is emitted before the reader resumes, so late seeds would hold later bytes. */
export async function drainRecords(stream: AssistantMessageEventStream): Promise<AssistantRecord[]> {
	await stream.result();
	const records: AssistantRecord[] = [];
	for await (const record of assistantRecords(stream)) records.push(record);
	return records;
}

export function publicEvents(records: AssistantRecord[]): AssistantMessageEvent[] {
	return records.flatMap((record) => (isAssistantProgress(record) ? [] : [record]));
}

export function progressRecords(records: AssistantRecord[]): AssistantProgress[] {
	return records.filter(isAssistantProgress);
}

export function recordKinds(records: AssistantRecord[]): string[] {
	return records.map((record) => {
		if (record.type === "message_block_state") return `${record.type}:${record.contentIndex}:${record.phase}`;
		return "contentIndex" in record ? `${record.type}:${record.contentIndex}` : record.type;
	});
}

export function publicBytes(events: AssistantMessageEvent[]): string {
	return JSON.stringify(events).replace(/"timestamp":\d+/g, '"timestamp":0');
}

export function deltaCaptures(
	events: AssistantMessageEvent[],
	type: "text_delta" | "thinking_delta" | "toolcall_delta",
): { delta: string; offset: number | undefined; parsedThrough: number | undefined }[] {
	return events.flatMap((event) => {
		if (event.type !== type || !("delta" in event)) return [];
		const capture = getAssistantCapture(event);
		return [{ delta: event.delta, offset: capture?.offset, parsedThrough: capture?.parsedThrough }];
	});
}

export function firstEvent<T extends AssistantMessageEvent["type"]>(
	events: AssistantMessageEvent[],
	type: T,
	contentIndex?: number,
): Extract<AssistantMessageEvent, { type: T }> {
	const found = events.find(
		(event): event is Extract<AssistantMessageEvent, { type: T }> =>
			event.type === type &&
			(contentIndex === undefined || ("contentIndex" in event && event.contentIndex === contentIndex)),
	);
	if (!found) throw new Error(`no ${type} event${contentIndex === undefined ? "" : ` at ${contentIndex}`}`);
	return found;
}

export function recordsOnForeignBlocks(records: AssistantRecord[], terminal: AssistantMessage): string[] {
	return records.flatMap((record) => {
		if (!("contentIndex" in record)) return [];
		const index = isAssistantProgress(record)
			? record.contentIndex
			: (getAssistantCapture(record)?.contentIndex ?? record.contentIndex);
		const kind = recordBlockKind(record);
		const actual = terminal.content[index]?.type;
		return kind === undefined || kind === actual ? [] : [`${record.type}:${index} names ${actual ?? "nothing"}`];
	});
}

function recordBlockKind(record: AssistantRecord): AssistantMessage["content"][number]["type"] | undefined {
	switch (record.type) {
		case "message_block_state":
			return record.block.type;
		case "message_block_metadata":
			return "textSignature" in record ? "text" : "name" in record ? "toolCall" : "thinking";
		case "message_tool_arguments_reset":
		case "toolcall_start":
		case "toolcall_delta":
		case "toolcall_end":
			return "toolCall";
		case "text_start":
		case "text_delta":
		case "text_end":
			return "text";
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
			return "thinking";
		default:
			return undefined;
	}
}

export function mintedIdentityKeys(message: object | undefined): string[] {
	return ["messageId", "turnId", "runtimeItemKey"].filter((key) => message !== undefined && key in message);
}
