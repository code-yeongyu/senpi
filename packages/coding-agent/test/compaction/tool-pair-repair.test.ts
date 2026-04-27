import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Context, Message, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import { complete, fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { repairOrphanedToolResults } from "../../src/core/extensions/builtin/compaction/tool-pair-repair.js";
import {
	type FileEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionMessageEntry,
} from "../../src/core/session-manager.js";

const TOOL_RESULT_PLACEHOLDER = "Tool output unavailable (context compacted)";
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function loadFixtureMessages(relativePath: string): Message[] {
	const fixturePath = join(TEST_DIR, "../fixtures/compaction", relativePath);
	const content = readFileSync(fixturePath, "utf-8");
	const fileEntries: FileEntry[] = parseSessionEntries(content);
	migrateSessionEntries(fileEntries);
	const messages: Message[] = [];
	for (const entry of fileEntries) {
		if (entry.type !== "message") continue;
		const messageEntry = entry as SessionMessageEntry;
		const message = messageEntry.message as Message;
		if (message.role === "toolResult") {
			messages.push({ ...message, isError: message.isError ?? false });
			continue;
		}
		messages.push(message);
	}
	return messages;
}

function toolResultsAsAgentToolResults(messages: Message[]): AgentToolResult<unknown>[] {
	const results: AgentToolResult<unknown>[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		results.push({
			content: message.content,
			details: undefined,
		});
	}
	return results;
}

function rebuildMessageStream(originalMessages: Message[], repairedResults: AgentToolResult<unknown>[]): Message[] {
	const next: Message[] = [];
	let repairedIndex = 0;
	for (const message of originalMessages) {
		if (message.role !== "toolResult") {
			next.push(message);
			continue;
		}
		const repaired = repairedResults[repairedIndex];
		repairedIndex++;
		if (!repaired) continue;
		const repairedMessage: ToolResultMessage = {
			...message,
			content: repaired.content,
		};
		next.push(repairedMessage);
	}
	return next;
}

function collectToolCallIds(messages: Message[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") ids.add(block.id);
		}
	}
	return ids;
}

function collectToolResultIds(messages: Message[]): string[] {
	const ids: string[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		ids.push(message.toolCallId);
	}
	return ids;
}

function findText(content: ToolResultMessage["content"]): string {
	for (const block of content) {
		if (block.type === "text") {
			return (block as TextContent).text;
		}
	}
	return "";
}

function buildValidPairsSession(): Message[] {
	const userMsg: Message = {
		role: "user",
		content: [{ type: "text", text: "List files" }],
		timestamp: 1,
	};
	const assistantMsg: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "ls", arguments: { path: "." } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 5,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
	const toolResultMsg: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "ls",
		content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
		isError: false,
		timestamp: 3,
	};
	return [userMsg, assistantMsg, toolResultMsg];
}

function buildToolCallWithoutResultSession(): Message[] {
	const userMsg: Message = {
		role: "user",
		content: [{ type: "text", text: "Run the build" }],
		timestamp: 1,
	};
	const assistantMsg: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "dangling-call-7", name: "bash", arguments: { command: "npm run build" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 6,
			output: 6,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
	return [userMsg, assistantMsg];
}

describe("compaction tool-pair repair behavior", () => {
	describe("Given session with valid tool_call/tool_result pairs", () => {
		describe("When tool-pair-repair runs", () => {
			it("Then no changes", () => {
				const messages = buildValidPairsSession();
				const inputs = toolResultsAsAgentToolResults(messages);

				const repaired = repairOrphanedToolResults(inputs);

				expect(repaired).toHaveLength(inputs.length);
				expect(repaired[0]?.content).toEqual(inputs[0].content);
			});
		});
	});

	describe("Given session with orphan tool_result (no preceding tool_call after compaction)", () => {
		describe("When tool-pair-repair runs", () => {
			it("Then orphan replaced with placeholder 'Tool output unavailable (context compacted)'", () => {
				const messages = loadFixtureMessages("tool-pair-repair/orphan-tool-result.jsonl");
				const toolCallIds = collectToolCallIds(messages);
				const orphanResult = messages.find(
					(m): m is ToolResultMessage => m.role === "toolResult" && !toolCallIds.has(m.toolCallId),
				);
				expect(orphanResult, "fixture must contain at least one orphan tool_result").toBeDefined();
				const inputs = toolResultsAsAgentToolResults(messages);

				const repaired = repairOrphanedToolResults(inputs);
				const reconstructed = rebuildMessageStream(messages, repaired);
				const orphanAfter = reconstructed.find(
					(m): m is ToolResultMessage =>
						m.role === "toolResult" && m.toolCallId === (orphanResult as ToolResultMessage).toolCallId,
				);

				expect(orphanAfter, "orphan must remain in the message stream after repair").toBeDefined();
				expect(findText((orphanAfter as ToolResultMessage).content)).toBe(TOOL_RESULT_PLACEHOLDER);
			});
		});
	});

	describe("Given session with tool_call without subsequent tool_result", () => {
		describe("When tool-pair-repair runs", () => {
			it("Then synthetic tool_result with placeholder content inserted", () => {
				const messages = buildToolCallWithoutResultSession();
				const toolCallIds = collectToolCallIds(messages);
				expect(toolCallIds.size).toBeGreaterThan(0);
				const inputs = toolResultsAsAgentToolResults(messages);

				const repaired = repairOrphanedToolResults(inputs);

				const syntheticTexts = repaired.map((result) => findText(result.content));
				const placeholderHits = syntheticTexts.filter((text) => text === TOOL_RESULT_PLACEHOLDER);
				expect(
					placeholderHits.length,
					"every dangling tool_call must produce a synthetic tool_result with the placeholder",
				).toBe(toolCallIds.size);
			});
		});
	});

	describe("Given repair completes", () => {
		describe("When sent to provider", () => {
			it("Then provider validation accepts the message array (no HTTP 400 from invalid pair)", async () => {
				const messages = loadFixtureMessages("tool-pair-repair/orphan-tool-result.jsonl");
				const inputs = toolResultsAsAgentToolResults(messages);
				const repaired = repairOrphanedToolResults(inputs);
				const reconstructed = rebuildMessageStream(messages, repaired);

				const toolCallIds = collectToolCallIds(reconstructed);
				const toolResultIds = collectToolResultIds(reconstructed);
				const orphans = toolResultIds.filter((id) => !toolCallIds.has(id));
				expect(orphans, "post-repair message stream must have no orphan tool_results").toEqual([]);

				const registration = registerFauxProvider();
				registrations.push(registration);
				registration.setResponses([fauxAssistantMessage("acknowledged")]);
				const model = registration.getModel();
				const context: Context = {
					systemPrompt: "test-system",
					messages: reconstructed,
				};

				const response = await complete(model, context, { sessionId: "pair-validation-session" });

				expect(response.stopReason).toBe("stop");
				expect(response.errorMessage).toBeUndefined();
				const callLog = registration.getCallLog();
				expect(callLog).toHaveLength(1);
				expect(callLog[0].context.messages.length).toBe(reconstructed.length);
			});
		});
	});
});
