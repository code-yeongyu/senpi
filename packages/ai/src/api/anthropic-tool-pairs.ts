import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages.js";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasMessagesArray(value: unknown): value is { messages: unknown[] } {
	return isObject(value) && Array.isArray(value.messages);
}

function isContentBlockParam(value: unknown): value is ContentBlockParam {
	return isObject(value) && typeof value.type === "string";
}

function isToolUseBlock(block: ContentBlockParam): block is Extract<ContentBlockParam, { type: "tool_use" }> {
	return block.type === "tool_use" && "id" in block && typeof block.id === "string";
}

function isToolResultBlock(block: ContentBlockParam): block is Extract<ContentBlockParam, { type: "tool_result" }> {
	return block.type === "tool_result";
}

const SYNTHETIC_OUTPUT = "Tool output unavailable (interrupted before result)";

function cloneWith<T extends object>(block: T, patch: Partial<T>): T {
	return { ...block, ...patch };
}

function isMessageWithArrayContent<Role extends MessageParam["role"]>(
	value: unknown,
	role: Role,
): value is MessageParam & { role: Role; content: ContentBlockParam[] } {
	if (!isObject(value) || value.role !== role || !Array.isArray(value.content)) return false;
	for (const block of value.content) {
		if (!isContentBlockParam(block)) return false;
	}
	return true;
}

function isUserMessageWithStringContent(value: unknown): value is MessageParam & { role: "user"; content: string } {
	return isObject(value) && value.role === "user" && typeof value.content === "string";
}

interface AssistantToolUseDedupe {
	message: MessageParam & { role: "assistant"; content: ContentBlockParam[] };
	changed: boolean;
	expectedIds: string[];
	remapQueues: Map<string, string[]>;
}

function dedupeAssistantToolUses(
	message: MessageParam & { role: "assistant"; content: ContentBlockParam[] },
	usedIds: Set<string>,
): AssistantToolUseDedupe {
	const content: ContentBlockParam[] = [];
	const expectedIds: string[] = [];
	const remapQueues = new Map<string, string[]>();
	let changed = false;
	for (const block of message.content) {
		if (!isToolUseBlock(block) || block.id.length === 0) {
			content.push(block);
			continue;
		}
		let finalId = block.id;
		if (usedIds.has(finalId)) {
			let suffix = 2;
			while (usedIds.has(`${block.id}__dedup${suffix}`)) suffix += 1;
			finalId = `${block.id}__dedup${suffix}`;
			changed = true;
		}
		usedIds.add(finalId);
		expectedIds.push(finalId);
		const queue = remapQueues.get(block.id);
		if (queue === undefined) remapQueues.set(block.id, [finalId]);
		else queue.push(finalId);
		content.push(finalId === block.id ? block : cloneWith(block, { id: finalId }));
	}
	if (!changed) return { message, changed: false, expectedIds, remapQueues };
	return { message: { ...message, content }, changed: true, expectedIds, remapQueues };
}

function syntheticToolResult(toolUseId: string): Extract<ContentBlockParam, { type: "tool_result" }> {
	return {
		type: "tool_result",
		tool_use_id: toolUseId,
		content: SYNTHETIC_OUTPUT,
		is_error: true,
	};
}

function sameBlocks(left: ContentBlockParam[], right: ContentBlockParam[]): boolean {
	return left.length === right.length && left.every((block, index) => block === right[index]);
}

function repairFollowingUserMessage(
	message: MessageParam & { role: "user"; content: ContentBlockParam[] },
	expectedIds: string[],
	remapQueues: Map<string, string[]>,
): { message: MessageParam; changed: boolean } {
	const expected = new Set(expectedIds);
	const found = new Set<string>();
	const results: ContentBlockParam[] = [];
	const ordinary: ContentBlockParam[] = [];

	for (const block of message.content) {
		if (!isToolResultBlock(block)) {
			ordinary.push(block);
			continue;
		}
		const rawId = block.tool_use_id;
		let id = rawId;
		if (typeof rawId === "string") {
			const queue = remapQueues.get(rawId);
			if (queue !== undefined && queue.length > 0) id = queue.shift() as string;
		}
		if (typeof id !== "string" || !expected.has(id) || found.has(id)) continue;
		found.add(id);
		results.push(id === rawId ? block : cloneWith(block, { tool_use_id: id }));
	}

	for (const id of expectedIds) {
		if (!found.has(id)) results.push(syntheticToolResult(id));
	}

	const content = [...results, ...ordinary];
	if (sameBlocks(content, message.content)) return { message, changed: false };
	return { message: { ...message, content }, changed: true };
}

function removeOrphanResults(message: MessageParam & { role: "user"; content: ContentBlockParam[] }): {
	message?: MessageParam;
	changed: boolean;
} {
	const content = message.content.filter((block) => !isToolResultBlock(block));
	if (content.length === message.content.length) return { message, changed: false };
	if (content.length === 0) return { changed: true };
	return { message: { ...message, content }, changed: true };
}

/** Repairs Anthropic client tool_use/tool_result adjacency and duplicate tool_use ids without mutating the input payload. */
export function sanitizeAnthropicToolPairs(payload: unknown): unknown {
	if (!hasMessagesArray(payload)) return payload;

	let changed = false;
	const usedToolUseIds = new Set<string>();
	const sanitizedMessages: unknown[] = [];

	for (let index = 0; index < payload.messages.length; index++) {
		const unknownMessage = payload.messages[index];
		if (isMessageWithArrayContent(unknownMessage, "assistant")) {
			const deduped = dedupeAssistantToolUses(unknownMessage, usedToolUseIds);
			sanitizedMessages.push(deduped.message);
			changed ||= deduped.changed;
			const expectedIds = deduped.expectedIds;
			if (expectedIds.length === 0) continue;

			const nextMessage = payload.messages[index + 1];
			if (isMessageWithArrayContent(nextMessage, "user")) {
				const repaired = repairFollowingUserMessage(nextMessage, expectedIds, deduped.remapQueues);
				sanitizedMessages.push(repaired.message);
				changed ||= repaired.changed;
				index++;
				continue;
			}

			if (isUserMessageWithStringContent(nextMessage)) {
				sanitizedMessages.push({
					...nextMessage,
					content: [...expectedIds.map(syntheticToolResult), { type: "text", text: nextMessage.content }],
				});
				changed = true;
				index++;
				continue;
			}

			sanitizedMessages.push({
				role: "user",
				content: expectedIds.map(syntheticToolResult),
			});
			changed = true;
			continue;
		}

		if (isMessageWithArrayContent(unknownMessage, "user")) {
			const repaired = removeOrphanResults(unknownMessage);
			if (repaired.message) sanitizedMessages.push(repaired.message);
			changed ||= repaired.changed;
			continue;
		}

		sanitizedMessages.push(unknownMessage);
	}

	if (!changed) return payload;
	return { ...payload, messages: sanitizedMessages };
}
