import { readFileSync } from "node:fs";
import type { UserMessage } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStreamingError } from "../../src/core/edited-assistant-message.ts";
import type { SessionBeforeTreeEvent, SessionTreeEvent } from "../../src/core/extensions/types.ts";
import { SessionManager, type SessionMessageEntry } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

function isUserEntry(entry: { type: string; message?: { role: string } }): entry is SessionMessageEntry {
	return entry.type === "message" && entry.message?.role === "user";
}

function isAssistantEntry(entry: { type: string; message?: { role: string } }): entry is SessionMessageEntry {
	return entry.type === "message" && entry.message?.role === "assistant";
}

function userEntries(harness: Harness): SessionMessageEntry[] {
	return harness.sessionManager.getEntries().filter(isUserEntry);
}

function assistantEntries(harness: Harness): SessionMessageEntry[] {
	return harness.sessionManager.getEntries().filter(isAssistantEntry);
}

function userMessageOf(entry: SessionMessageEntry): UserMessage {
	if (entry.message.role !== "user") throw new Error(`entry ${entry.id} is not a user message`);
	return entry.message;
}

function branchIds(harness: Harness): string[] {
	return harness.sessionManager.getBranch().map((entry) => entry.id);
}

function branchRoles(harness: Harness): string[] {
	return harness.sessionManager
		.getBranch()
		.map((entry) => (entry.type === "message" ? entry.message.role : entry.type));
}

function sessionFileText(harness: Harness): string {
	const file = harness.sessionManager.getSessionFile();
	if (!file) throw new Error("expected a persisted session file");
	return readFileSync(file, "utf8");
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
	return pending.then(
		() => undefined,
		(error: unknown) => error,
	);
}

/**
 * `UserEditError` is asserted structurally rather than with `instanceof`: the suite has to
 * collect - and every case has to fail on its own assertion - before the module it would be
 * imported from exists.
 */
function expectUserEditError(error: unknown, reason: string, code: string): void {
	const failure = error as { name?: string; reason?: string; code?: string } | undefined;
	expect(failure?.name).toBe("UserEditError");
	expect(failure?.reason).toBe(reason);
	expect(failure?.code).toBe(code);
}

describe("AgentSession.editUserMessage", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const treeEvents: SessionTreeEvent[] = [];
	const beforeTreeEvents: SessionBeforeTreeEvent[] = [];
	const agentStarts: string[] = [];

	/** user "first" -> assistant "one" -> user "second" -> assistant "two". */
	async function createConversation(extra: Partial<HarnessOptions> = {}): Promise<Harness> {
		const harness = await createHarness({
			persistSession: true,
			...extra,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", (event) => {
						beforeTreeEvents.push(event);
						return undefined;
					});
					pi.on("session_tree", (event) => {
						treeEvents.push(event);
					});
					pi.on("agent_start", () => {
						agentStarts.push("agent_start");
					});
				},
				...(extra.extensionFactories ?? []),
			],
		});
		harnesses.push(harness);
		treeEvents.length = 0;
		beforeTreeEvents.length = 0;
		agentStarts.length = 0;
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		return harness;
	}

	it("(a) moves the leaf to the target's parent and appends the edited prompt as the new leaf", async () => {
		const harness = await createConversation();
		const [u1, u2] = userEntries(harness);
		const [, a2] = assistantEntries(harness);
		if (!u1 || !u2 || !a2) throw new Error("expected a two-turn conversation");
		const entryCountBefore = harness.sessionManager.getEntries().length;
		const leafBefore = harness.sessionManager.getLeafId();

		const result = await harness.session.editUserMessage(u2.id, "second, edited", { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(result.unchanged).toBeUndefined();
		// The edited prompt is already appended; there is nothing for a composer to pick up.
		expect(result.editorText).toBeUndefined();
		if (!result.entryId) throw new Error("expected the edited entry id");
		const edited = harness.sessionManager.getEntry(result.entryId);
		if (!edited || !isUserEntry(edited)) throw new Error("expected the edited user entry");
		expect(edited.parentId).toBe(u2.parentId);
		expect(harness.sessionManager.getLeafId()).toBe(edited.id);
		expect(userMessageOf(edited).content).toEqual([{ type: "text", text: "second, edited" }]);

		// The target and everything after it stay in the file, off the active path.
		expect(harness.sessionManager.getEntries().length).toBe(entryCountBefore + 1);
		expect(getMessageText(userMessageOf(u2))).toBe("second");
		expect(harness.sessionManager.getEntry(a2.id)).toBeDefined();
		expect(branchIds(harness)).toContain(edited.id);
		expect(branchIds(harness)).not.toContain(u2.id);
		expect(branchIds(harness)).not.toContain(a2.id);
		const file = sessionFileText(harness);
		expect(file).toContain(u2.id);
		expect(file).toContain(a2.id);

		const contextMessages = harness.sessionManager.buildSessionContext().messages;
		expect(contextMessages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(getMessageText(contextMessages[contextMessages.length - 1])).toBe("second, edited");
		expect(harness.agent.state.messages).toHaveLength(contextMessages.length);
		expect(treeEvents).toHaveLength(1);
		expect(treeEvents[0]?.newLeafId).toBe(edited.id);
		expect(treeEvents[0]?.oldLeafId).toBe(leafBefore);
	});

	it("(b) leaves the session untouched when the text did not change", async () => {
		const harness = await createConversation();
		const [, u2] = userEntries(harness);
		if (!u2) throw new Error("expected a second user entry");
		const leafBefore = harness.sessionManager.getLeafId();
		const entryCountBefore = harness.sessionManager.getEntries().length;

		const result = await harness.session.editUserMessage(u2.id, "  second\n", { summarize: false });

		expect(result.unchanged).toBe(true);
		expect(result.entryId).toBeUndefined();
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
		expect(harness.sessionManager.getEntries().length).toBe(entryCountBefore);
		expect(beforeTreeEvents).toHaveLength(0);
		expect(treeEvents).toHaveLength(0);
	});

	it("(c) rejects a blank replacement with empty", async () => {
		const harness = await createConversation();
		const [, u2] = userEntries(harness);
		if (!u2) throw new Error("expected a second user entry");
		const leafBefore = harness.sessionManager.getLeafId();
		const entryCountBefore = harness.sessionManager.getEntries().length;

		const error = await rejectionOf(harness.session.editUserMessage(u2.id, "   \n", { summarize: false }));

		expectUserEditError(error, "empty", "empty");
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
		expect(harness.sessionManager.getEntries().length).toBe(entryCountBefore);
	});

	it("(d) rejects an assistant target with not_user and a missing target with not_found", async () => {
		const harness = await createConversation();
		const [a1] = assistantEntries(harness);
		if (!a1) throw new Error("expected an assistant entry");
		const leafBefore = harness.sessionManager.getLeafId();
		const entryCountBefore = harness.sessionManager.getEntries().length;

		const notUser = await rejectionOf(harness.session.editUserMessage(a1.id, "x", { summarize: false }));
		const notFound = await rejectionOf(harness.session.editUserMessage("missing-entry", "x", { summarize: false }));

		expectUserEditError(notUser, "not-user", "not_user");
		expectUserEditError(notFound, "not-found", "not_found");
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
		expect(harness.sessionManager.getEntries().length).toBe(entryCountBefore);
	});

	it("(e) refuses a stale token before any extension hears about the navigation", async () => {
		const harness = await createConversation();
		const [, u2] = userEntries(harness);
		if (!u2) throw new Error("expected a second user entry");
		const leafBefore = harness.sessionManager.getLeafId();
		const entryCountBefore = harness.sessionManager.getEntries().length;

		const error = await rejectionOf(
			harness.session.editUserMessage(u2.id, "second, edited", {
				summarize: false,
				expectedLeafId: "entry-from-another-window",
			}),
		);

		expectUserEditError(error, "stale-leaf", "stale_leaf");
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
		expect(harness.sessionManager.getEntries().length).toBe(entryCountBefore);
		expect(beforeTreeEvents).toHaveLength(0);
		expect(treeEvents).toHaveLength(0);
	});

	it("(f) reports a stale token even when the replacement text is identical", async () => {
		const harness = await createConversation();
		const [, u2] = userEntries(harness);
		if (!u2) throw new Error("expected a second user entry");
		const leafBefore = harness.sessionManager.getLeafId();
		const entryCountBefore = harness.sessionManager.getEntries().length;

		const error = await rejectionOf(
			harness.session.editUserMessage(u2.id, "  second\n", {
				summarize: false,
				expectedLeafId: "entry-from-another-window",
			}),
		);

		// The stale check runs before the unchanged comparison: a stale window never learns "unchanged".
		expectUserEditError(error, "stale-leaf", "stale_leaf");
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
		expect(harness.sessionManager.getEntries().length).toBe(entryCountBefore);
		expect(beforeTreeEvents).toHaveLength(0);
		expect(treeEvents).toHaveLength(0);
	});

	it("(g) preserves the original attachments in the edited copy", async () => {
		const harness = await createConversation();
		harness.setResponses([fauxAssistantMessage("saw it")]);
		await harness.session.prompt("describe", {
			images: [{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }],
		});
		const withImage = userEntries(harness).at(-1);
		if (!withImage) throw new Error("expected the user entry carrying an image");
		expect(userMessageOf(withImage).content).toEqual([
			{ type: "text", text: "describe" },
			{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
		]);

		const result = await harness.session.editUserMessage(withImage.id, "describe it in detail", {
			summarize: false,
		});

		if (!result.entryId) throw new Error("expected the edited entry id");
		const edited = harness.sessionManager.getEntry(result.entryId);
		if (!edited || !isUserEntry(edited)) throw new Error("expected the edited user entry");
		// A user's attachments are input, not model output: dropping them would destroy data.
		expect(userMessageOf(edited).content).toEqual([
			{ type: "text", text: "describe it in detail" },
			{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
		]);
		expect(userMessageOf(withImage).content).toEqual([
			{ type: "text", text: "describe" },
			{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
		]);
	});

	it("(h) refuses to edit while a response is streaming and keeps the leaf", async () => {
		const harness = await createConversation();
		const [, u2] = userEntries(harness);
		if (!u2) throw new Error("expected a second user entry");
		let editResult: unknown;
		let staleEditResult: unknown;
		let leafDuringEdit: string | null | undefined;
		harness.setResponses([
			async () => {
				editResult = await harness.session
					.editUserMessage(u2.id, "edited mid-stream", { summarize: false })
					.catch((error: unknown) => error);
				staleEditResult = await harness.session
					.editUserMessage(u2.id, "edited mid-stream", {
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
		for (const error of [editResult, staleEditResult]) {
			expect(error).toBeInstanceOf(SessionStreamingError);
			expect((error as SessionStreamingError).code).toBe("streaming");
		}
		expect(leafDuringEdit).not.toBe(u2.parentId);
		expect(userEntries(harness).some((entry) => getMessageText(userMessageOf(entry)) === "edited mid-stream")).toBe(
			false,
		);
	});

	it("(i) leaves a prompt with no reply as the leaf and runs no turn, in this session or a reopened one", async () => {
		const harness = await createConversation();
		const [, u2] = userEntries(harness);
		if (!u2) throw new Error("expected a second user entry");
		// A turn that auto-ran would consume this response.
		harness.setResponses([fauxAssistantMessage("must not run")]);
		const agentStartsBefore = agentStarts.length;

		const result = await harness.session.editUserMessage(u2.id, "second, edited", { summarize: false });
		// Yield the macrotask queue so a turn scheduled by the edit would have started by now.
		await new Promise((resolve) => setImmediate(resolve));

		if (!result.entryId) throw new Error("expected the edited entry id");
		const leaf = harness.sessionManager.getEntry(result.entryId);
		if (!leaf || !isUserEntry(leaf)) throw new Error("expected a user message as the leaf");
		expect(harness.sessionManager.getLeafId()).toBe(leaf.id);
		expect(harness.sessionManager.getEntries().some((entry) => entry.parentId === leaf.id)).toBe(false);
		expect(harness.session.isStreaming).toBe(false);
		expect(agentStarts.length).toBe(agentStartsBefore);
		expect(harness.getPendingResponseCount()).toBe(1);

		const file = harness.sessionManager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		const reopened = SessionManager.open(file);
		const reopenedLeafId = reopened.getLeafId();
		const reopenedLeaf = reopenedLeafId ? reopened.getEntry(reopenedLeafId) : undefined;
		if (!reopenedLeaf || !isUserEntry(reopenedLeaf)) throw new Error("expected the reopened leaf to be a prompt");
		expect(reopenedLeafId).toBe(leaf.id);
		expect(reopened.getEntries().some((entry) => entry.parentId === reopenedLeaf.id)).toBe(false);
		expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
		expect(agentStarts.length).toBe(agentStartsBefore);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("(j) appends exactly one prompt on the next turn and never re-appends the edited one", async () => {
		const harness = await createConversation();
		const [, u2] = userEntries(harness);
		if (!u2) throw new Error("expected a second user entry");

		const result = await harness.session.editUserMessage(u2.id, "second, edited", { summarize: false });
		if (!result.entryId) throw new Error("expected the edited entry id");
		const userCountAfterEdit = userEntries(harness).length;
		let promptedTexts: string[] = [];
		harness.setResponses([
			(context) => {
				promptedTexts = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("three");
			},
		]);

		await harness.session.prompt("third");

		// The edited prompt is written once, by the edit. The turn appends only its own prompt.
		expect(userEntries(harness).length).toBe(userCountAfterEdit + 1);
		expect(promptedTexts.filter((text) => text === "second, edited")).toHaveLength(1);
		const branchTexts = harness.sessionManager
			.getBranch()
			.filter(isUserEntry)
			.map((entry) => getMessageText(userMessageOf(entry)));
		expect(branchTexts).toEqual(["first", "second, edited", "third"]);
		// The engine appends every prompt under the current leaf, so a turn started on an
		// unanswered prompt legitimately leaves two prompts in a row. Nothing is duplicated.
		expect(branchRoles(harness)).toEqual(["user", "assistant", "user", "user", "assistant"]);
	});

	it("(k) assembles context and compacts over the unanswered prompt", async () => {
		const harness = await createConversation({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary of the abandoned work",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		const [, u2] = userEntries(harness);
		if (!u2) throw new Error("expected a second user entry");

		const result = await harness.session.editUserMessage(u2.id, "second, edited", { summarize: false });

		if (!result.entryId) throw new Error("expected the edited entry id");
		const contextMessages = harness.sessionManager.buildSessionContext().messages;
		expect(contextMessages[contextMessages.length - 1]?.role).toBe("user");
		expect(harness.session.messages.map((message) => message.role)).toEqual(
			contextMessages.map((message) => message.role),
		);

		const compaction = await harness.session.compact();

		expect(compaction.summary).toBe("summary of the abandoned work");
		const afterCompaction = harness.sessionManager.buildSessionContext().messages;
		expect(afterCompaction.map((message) => message.role)).toEqual(["compactionSummary", "user"]);
		expect(getMessageText(afterCompaction[afterCompaction.length - 1])).toBe("second, edited");
		expect(harness.session.messages.map((message) => message.role)).toEqual(
			afterCompaction.map((message) => message.role),
		);
	});
});
