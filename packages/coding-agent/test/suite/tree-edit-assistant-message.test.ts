import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantEditError, SessionStreamingError } from "../../src/core/edited-assistant-message.ts";
import type { SessionBeforeTreeEvent, SessionTreeEvent } from "../../src/core/extensions/types.ts";
import type { SessionMessageEntry } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function isAssistantEntry(entry: { type: string; message?: { role: string } }): entry is SessionMessageEntry {
	return entry.type === "message" && entry.message?.role === "assistant";
}

function assistantEntries(harness: Harness): SessionMessageEntry[] {
	return harness.sessionManager.getEntries().filter(isAssistantEntry);
}

function assistantMessageOf(entry: SessionMessageEntry): AssistantMessage {
	if (entry.message.role !== "assistant") throw new Error(`entry ${entry.id} is not an assistant message`);
	return entry.message;
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
	return pending.then(
		() => undefined,
		(error: unknown) => error,
	);
}

describe("AgentSession.editAssistantMessage", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const treeEvents: SessionTreeEvent[] = [];
	const beforeTreeEvents: SessionBeforeTreeEvent[] = [];

	async function createConversation(): Promise<Harness> {
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", (event) => {
						beforeTreeEvents.push(event);
						return undefined;
					});
					pi.on("session_tree", (event) => {
						treeEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		treeEvents.length = 0;
		beforeTreeEvents.length = 0;
		harness.setResponses([fauxAssistantMessage("The answer is 41."), fauxAssistantMessage("Anything else?")]);
		await harness.session.prompt("What is the answer?");
		await harness.session.prompt("Thanks");
		return harness;
	}

	it("appends an edited copy under the original parent and makes it the leaf", async () => {
		const harness = await createConversation();
		const [a1] = assistantEntries(harness);
		if (!a1) throw new Error("expected an assistant entry");
		const original = assistantMessageOf(a1);
		const entryCountBefore = harness.sessionManager.getEntries().length;
		const leafBefore = harness.sessionManager.getLeafId();

		const result = await harness.session.editAssistantMessage(a1.id, "The answer is 42.", { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(result.unchanged).toBeUndefined();
		if (!result.entryId) throw new Error("expected the edited entry id");
		const edited = harness.sessionManager.getEntry(result.entryId);
		if (!edited || !isAssistantEntry(edited)) throw new Error("expected the edited assistant entry");
		const editedMessage = assistantMessageOf(edited);
		expect(edited.parentId).toBe(a1.parentId);
		expect(harness.sessionManager.getLeafId()).toBe(edited.id);
		expect(editedMessage.content).toEqual([{ type: "text", text: "The answer is 42." }]);
		expect(editedMessage.stopReason).toBe("stop");
		expect(editedMessage.model).toBe(original.model);
		expect(editedMessage.provider).toBe(original.provider);
		expect(editedMessage.api).toBe(original.api);
		expect(editedMessage.usage).toEqual(original.usage);
		expect(getMessageText(assistantMessageOf(a1))).toBe("The answer is 41.");
		expect(harness.sessionManager.getEntries().length).toBe(entryCountBefore + 1);
		const contextMessages = harness.sessionManager.buildSessionContext().messages;
		const lastMessage = contextMessages[contextMessages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		expect(lastMessage && getMessageText(lastMessage)).toBe("The answer is 42.");
		expect(contextMessages.some((message) => message.role === "user" && getMessageText(message) === "Thanks")).toBe(
			false,
		);
		expect(harness.agent.state.messages).toHaveLength(contextMessages.length);
		expect(treeEvents).toHaveLength(1);
		expect(treeEvents[0]?.newLeafId).toBe(edited.id);
		expect(treeEvents[0]?.oldLeafId).toBe(leafBefore);
	});

	it("keeps only the edited text when the original carried thinking and tool calls", async () => {
		const harness = await createConversation();
		const [a1] = assistantEntries(harness);
		if (!a1) throw new Error("expected an assistant entry");
		harness.sessionManager.branch(a1.id);
		const withTools = fauxAssistantMessage(
			[
				fauxThinking("Let me look."),
				fauxText("Checking the file."),
				fauxToolCall("read", { path: "x" }, { id: "call-1" }),
			],
			{ stopReason: "toolUse" },
		);
		const toolCallEntryId = harness.sessionManager.appendMessage(withTools);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: Date.now(),
		});

		const result = await harness.session.editAssistantMessage(toolCallEntryId, "Here is the answer.", {
			summarize: false,
		});

		if (!result.entryId) throw new Error("expected the edited entry id");
		const edited = harness.sessionManager.getEntry(result.entryId);
		if (!edited || !isAssistantEntry(edited)) throw new Error("expected the edited assistant entry");
		const editedMessage = assistantMessageOf(edited);
		expect(edited.parentId).toBe(a1.id);
		expect(editedMessage.content).toEqual([{ type: "text", text: "Here is the answer." }]);
		expect(editedMessage.stopReason).toBe("stop");
		const contextMessages = harness.sessionManager.buildSessionContext().messages;
		expect(contextMessages.some((message) => message.role === "toolResult")).toBe(false);
		expect(contextMessages[contextMessages.length - 1]?.role).toBe("assistant");
	});

	it("leaves the session untouched when the text did not change", async () => {
		const harness = await createConversation();
		const [a1] = assistantEntries(harness);
		if (!a1) throw new Error("expected an assistant entry");
		const leafBefore = harness.sessionManager.getLeafId();
		const entryCountBefore = harness.sessionManager.getEntries().length;

		const result = await harness.session.editAssistantMessage(a1.id, "  The answer is 41.\n", { summarize: false });

		expect(result.unchanged).toBe(true);
		expect(result.entryId).toBeUndefined();
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
		expect(harness.sessionManager.getEntries().length).toBe(entryCountBefore);
	});

	it("rejects targets that are not assistant messages and empty replacements", async () => {
		const harness = await createConversation();
		const [a1] = assistantEntries(harness);
		if (!a1?.parentId) throw new Error("expected a parented assistant entry");
		const leafBefore = harness.sessionManager.getLeafId();

		await expect(harness.session.editAssistantMessage(a1.parentId, "x", { summarize: false })).rejects.toThrow(
			/not an assistant message/,
		);
		await expect(harness.session.editAssistantMessage("missing-entry", "x", { summarize: false })).rejects.toThrow(
			/not found/,
		);
		await expect(harness.session.editAssistantMessage(a1.id, "   \n", { summarize: false })).rejects.toThrow(/empty/);
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
	});

	it("rejects an empty replacement for an assistant message that has no text", async () => {
		const harness = await createConversation();
		const toolOnlyId = harness.sessionManager.appendMessage(
			fauxAssistantMessage([fauxToolCall("read", { path: "x" }, { id: "call-2" })], { stopReason: "toolUse" }),
		);
		const entryCountBefore = harness.sessionManager.getEntries().length;

		await expect(harness.session.editAssistantMessage(toolOnlyId, "  ", { summarize: false })).rejects.toThrow(
			/empty/,
		);
		expect(harness.sessionManager.getEntries().length).toBe(entryCountBefore);
	});

	it("refuses a stale edit before comparing the replacement text", async () => {
		const harness = await createConversation();
		const [a1] = assistantEntries(harness);
		if (!a1) throw new Error("expected an assistant entry");
		const leafBefore = harness.sessionManager.getLeafId();
		const entryCountBefore = harness.sessionManager.getEntries().length;

		const changed = await rejectionOf(
			harness.session.editAssistantMessage(a1.id, "The answer is 42.", {
				summarize: false,
				expectedLeafId: "entry-from-another-window",
			}),
		);
		const identical = await rejectionOf(
			harness.session.editAssistantMessage(a1.id, "  The answer is 41.\n", {
				summarize: false,
				expectedLeafId: "entry-from-another-window",
			}),
		);

		for (const error of [changed, identical]) {
			expect(error).toBeInstanceOf(AssistantEditError);
			expect((error as AssistantEditError).reason).toBe("stale-leaf");
			expect((error as AssistantEditError).code).toBe("stale_leaf");
		}
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
		expect(harness.sessionManager.getEntries().length).toBe(entryCountBefore);
		expect(beforeTreeEvents).toHaveLength(0);
		expect(treeEvents).toHaveLength(0);
	});

	it("edits when the expected leaf matches and burns the token for the next edit", async () => {
		const harness = await createConversation();
		const [a1] = assistantEntries(harness);
		const expectedLeafId = harness.sessionManager.getLeafId();
		if (!a1) throw new Error("expected an assistant entry");
		if (!expectedLeafId) throw new Error("expected a session leaf");

		const result = await harness.session.editAssistantMessage(a1.id, "The answer is 42.", {
			summarize: false,
			expectedLeafId,
		});

		expect(result.cancelled).toBe(false);
		if (!result.entryId) throw new Error("expected the edited entry id");
		expect(harness.sessionManager.getLeafId()).toBe(result.entryId);

		const entryCountAfterEdit = harness.sessionManager.getEntries().length;
		const retry = await rejectionOf(
			harness.session.editAssistantMessage(a1.id, "The answer is 43.", { summarize: false, expectedLeafId }),
		);

		expect(retry).toBeInstanceOf(AssistantEditError);
		expect((retry as AssistantEditError).reason).toBe("stale-leaf");
		expect(harness.sessionManager.getLeafId()).toBe(result.entryId);
		expect(harness.sessionManager.getEntries().length).toBe(entryCountAfterEdit);
	});

	it("rejects a stale navigateTree even when the target is already the leaf", async () => {
		const harness = await createConversation();
		const leafBefore = harness.sessionManager.getLeafId();
		if (!leafBefore) throw new Error("expected a session leaf");
		const entryCountBefore = harness.sessionManager.getEntries().length;

		const error = await rejectionOf(
			harness.session.navigateTree(leafBefore, { summarize: false, expectedLeafId: "entry-from-another-window" }),
		);

		expect(error).toBeInstanceOf(AssistantEditError);
		expect((error as AssistantEditError).reason).toBe("stale-leaf");
		expect((error as AssistantEditError).code).toBe("stale_leaf");
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
		expect(harness.sessionManager.getEntries().length).toBe(entryCountBefore);
		expect(beforeTreeEvents).toHaveLength(0);
		expect(treeEvents).toHaveLength(0);
	});

	it("refuses to edit while a response is streaming and keeps the leaf", async () => {
		const harness = await createConversation();
		const [a1] = assistantEntries(harness);
		if (!a1) throw new Error("expected an assistant entry");
		let editResult: unknown;
		let unchangedEditResult: unknown;
		let staleEditResult: unknown;
		let leafDuringEdit: string | null | undefined;
		harness.setResponses([
			async () => {
				editResult = await harness.session
					.editAssistantMessage(a1.id, "edited mid-stream", { summarize: false })
					.catch((error: unknown) => error);
				unchangedEditResult = await harness.session
					.editAssistantMessage(a1.id, "The answer is 41.", { summarize: false })
					.catch((error: unknown) => error);
				staleEditResult = await harness.session
					.editAssistantMessage(a1.id, "edited mid-stream", {
						summarize: false,
						expectedLeafId: "entry-from-another-window",
					})
					.catch((error: unknown) => error);
				leafDuringEdit = harness.sessionManager.getLeafId();
				return fauxAssistantMessage("streamed");
			},
		]);

		await harness.session.prompt("third");

		// Streaming outranks the stale-leaf guard: a busy session never reports a stale token.
		for (const error of [editResult, unchangedEditResult, staleEditResult]) {
			expect(error).toBeInstanceOf(SessionStreamingError);
			expect((error as SessionStreamingError).code).toBe("streaming");
			expect((error as Error).message).toBe(
				"Wait for the current response to finish before navigating the session tree.",
			);
		}
		expect(leafDuringEdit).not.toBe(a1.parentId);
		expect(
			assistantEntries(harness).some((entry) => getMessageText(assistantMessageOf(entry)) === "edited mid-stream"),
		).toBe(false);
	});
});
