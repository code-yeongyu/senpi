import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Context, Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	repairOrphanedToolResults,
	TOOL_RESULT_PLACEHOLDER,
} from "../../src/core/extensions/builtin/compaction/repair-tool-pairs.ts";
import {
	type FileEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionMessageEntry,
} from "../../src/core/session-manager.ts";

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

function buildFlaggedDanglingCallSession(errorMessage?: string): Message[] {
	const userMsg: Message = {
		role: "user",
		content: [{ type: "text", text: "Run the build" }],
		timestamp: 1,
	};
	const assistantMsg: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "flagged-call-1",
				name: "bash",
				arguments: {},
				incomplete: true,
				...(errorMessage ? { errorMessage } : {}),
			},
		],
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

function expectedRetryText(name: string): string {
	return `Tool call "${name}" was not executed: the response ended before the tool call was complete. Re-issue the tool call with complete arguments.`;
}

describe("compaction tool-pair repair behavior", () => {
	describe("Given session with valid tool_call/tool_result pairs", () => {
		describe("When tool-pair-repair runs", () => {
			it("Then no changes", () => {
				const messages = buildValidPairsSession();
				const reconstructed = repairOrphanedToolResults(messages);
				expect(reconstructed).toHaveLength(messages.length);
				expect(reconstructed).toEqual(messages);
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

				const reconstructed = repairOrphanedToolResults(messages);
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

				const reconstructed = repairOrphanedToolResults(messages);

				const syntheticResults = reconstructed.filter(
					(m): m is ToolResultMessage =>
						m.role === "toolResult" && findText(m.content) === TOOL_RESULT_PLACEHOLDER,
				);
				expect(
					syntheticResults.length,
					"every dangling tool_call must produce a synthetic tool_result with the placeholder",
				).toBe(toolCallIds.size);
			});
		});
	});

	describe("Given repair completes", () => {
		describe("When sent to provider", () => {
			it("Then provider validation accepts the message array (no HTTP 400 from invalid pair)", async () => {
				const messages = loadFixtureMessages("tool-pair-repair/orphan-tool-result.jsonl");
				const reconstructed = repairOrphanedToolResults(messages);

				const toolCallIds = collectToolCallIds(reconstructed);
				const orphanToolResults = reconstructed.filter(
					(m): m is ToolResultMessage => m.role === "toolResult" && !toolCallIds.has(m.toolCallId),
				);
				for (const orphan of orphanToolResults) {
					expect(findText(orphan.content)).toBe(TOOL_RESULT_PLACEHOLDER);
				}

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

	// todo-12: error placeholders with retry diagnostics for flagged dangling calls
	describe("Given session with a flagged (`incomplete: true`) dangling tool call", () => {
		describe("When tool-pair-repair runs", () => {
			it("Then exactly one isError:true tool_result with retry diagnostic text is synthesized (case a)", () => {
				const messages = buildFlaggedDanglingCallSession();

				const reconstructed = repairOrphanedToolResults(messages);

				expect(reconstructed).toHaveLength(messages.length + 1);
				const synth = reconstructed.at(-1) as ToolResultMessage;
				expect(synth.role).toBe("toolResult");
				expect(synth.toolCallId).toBe("flagged-call-1");
				expect(synth.toolName).toBe("bash");
				expect(synth.isError).toBe(true);
				expect(findText(synth.content)).toBe(expectedRetryText("bash"));
				const errorResults = reconstructed.filter(
					(m): m is ToolResultMessage => m.role === "toolResult" && m.isError === true,
				);
				expect(errorResults).toHaveLength(1);
			});
		});
	});

	describe("Given a session already repaired once", () => {
		describe("When tool-pair-repair runs a second time", () => {
			it("Then output deep-equals the first pass (idempotency, case b)", () => {
				const messages = buildFlaggedDanglingCallSession();

				const once = repairOrphanedToolResults(messages);
				const twice = repairOrphanedToolResults(once);

				expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
			});
		});
	});

	describe("Given session with a legacy (non-flagged) dangling tool call", () => {
		describe("When tool-pair-repair runs", () => {
			it("Then synthetic tool_result keeps isError:false and the placeholder content (case c)", () => {
				const messages = buildToolCallWithoutResultSession();

				const reconstructed = repairOrphanedToolResults(messages);

				const synth = reconstructed.at(-1) as ToolResultMessage;
				expect(synth.role).toBe("toolResult");
				expect(synth.isError).toBe(false);
				expect(findText(synth.content)).toBe(TOOL_RESULT_PLACEHOLDER);
			});
		});
	});

	describe("Given a flagged tool call that already has a real tool_result", () => {
		describe("When tool-pair-repair runs", () => {
			it("Then the existing tool_result is left untouched (case d)", () => {
				const messages = buildFlaggedDanglingCallSession();
				const realResult: ToolResultMessage = {
					role: "toolResult",
					toolCallId: "flagged-call-1",
					toolName: "bash",
					content: [{ type: "text", text: "real tool output" }],
					isError: false,
					timestamp: 3,
				};
				messages.push(realResult);

				const reconstructed = repairOrphanedToolResults(messages);

				expect(reconstructed).toEqual(messages);
				const preserved = reconstructed.at(-1) as ToolResultMessage;
				expect(preserved.isError).toBe(false);
				expect(findText(preserved.content)).toBe("real tool output");
			});
		});
	});

	describe("Given a flagged tool call carrying an errorMessage", () => {
		describe("When tool-pair-repair runs", () => {
			it("Then the synthesized result appends the retry instruction to the errorMessage", () => {
				const messages = buildFlaggedDanglingCallSession("custom truncation reason");

				const reconstructed = repairOrphanedToolResults(messages);

				const synth = reconstructed.at(-1) as ToolResultMessage;
				expect(synth.isError).toBe(true);
				expect(findText(synth.content)).toBe(
					"custom truncation reason. Re-issue the tool call with complete arguments.",
				);
			});
		});
	});

	describe("Given session with a dangling tool call on an errored/aborted assistant", () => {
		describe("When tool-pair-repair runs", () => {
			it("Then no synthetic result is added (transformMessages drops the assistant downstream)", () => {
				for (const stopReason of ["error", "aborted"] as const) {
					const messages = buildToolCallWithoutResultSession();
					messages[1] = { ...(messages[1] as AssistantMessage), stopReason };

					const reconstructed = repairOrphanedToolResults(messages);

					expect(reconstructed).toEqual(messages);
				}
			});
		});
	});
});
