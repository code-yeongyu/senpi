import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { prepareBranchEntries } from "../../src/core/compaction/branch-summarization.ts";
import {
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	prepareCompaction,
} from "../../src/core/compaction/compaction.ts";
import {
	type CustomMessage,
	convertToLlm,
	filterContextExcludedMessages,
	isContextExcludedCustomMessage,
} from "../../src/core/messages.ts";
import { buildSessionContext, type SessionEntry } from "../../src/core/session-manager.ts";

const GOAL_CONTINUATION_MESSAGE_TYPE = "goal-continuation";

function goalContinuation(content: string, timestamp: number): CustomMessage {
	return {
		role: "custom",
		customType: GOAL_CONTINUATION_MESSAGE_TYPE,
		content,
		display: false,
		timestamp,
	};
}

function customMessage(content: string, timestamp: number): CustomMessage {
	return {
		role: "custom",
		customType: "test-note",
		content,
		display: false,
		timestamp,
	};
}

function llmText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => (block.type === "text" ? block.text : "[non-text]")).join("");
}

function continuationContents(messages: AgentMessage[]): string[] {
	return messages.flatMap((message) =>
		message.role === "custom" && message.customType === GOAL_CONTINUATION_MESSAGE_TYPE
			? [typeof message.content === "string" ? message.content : "[non-text]"]
			: [],
	);
}

function fixtureAssistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixture-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

describe("goal-continuation context retention", () => {
	test.each([
		{ name: "zero", messages: [] as AgentMessage[], expected: [] as string[] },
		{
			name: "one",
			messages: [goalContinuation("live continuation", 1)] as AgentMessage[],
			expected: ["live continuation"],
		},
		{
			name: "many",
			messages: [
				goalContinuation("continuation one", 1),
				goalContinuation("continuation two", 2),
				goalContinuation("continuation three", 3),
			] as AgentMessage[],
			expected: ["continuation one", "continuation two", "continuation three"],
		},
	])("retains every continuation when the array has $name", ({ messages, expected }) => {
		expect(continuationContents(filterContextExcludedMessages(messages))).toEqual(expected);
		expect(convertToLlm(messages).map(llmText)).toEqual(expected);
	});

	test("keeps an interleaved continuation history append-only and in order", () => {
		// The cache prefix of request N must survive verbatim into request N+1, so an
		// earlier continuation may never be dropped once the provider has seen it.
		const messages: AgentMessage[] = [
			{ role: "user", content: "user-0", timestamp: 1 },
			goalContinuation("continuation-1", 2),
			fixtureAssistantMessage("assistant-1", 3),
			goalContinuation("continuation-2", 4),
		];

		const filtered = filterContextExcludedMessages(messages);

		expect(filtered).toEqual(messages);
		expect(convertToLlm(messages).map(llmText)).toEqual([
			"user-0",
			"continuation-1",
			"assistant-1",
			"continuation-2",
		]);
	});

	test("keeps non-goal messages and their ordering unchanged", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "before", timestamp: 1 },
			goalContinuation("earlier continuation", 2),
			customMessage("non-goal custom", 3),
			goalContinuation("latest continuation", 4),
			{ role: "user", content: "after", timestamp: 5 },
		];

		const filtered = filterContextExcludedMessages(messages);

		expect(filtered).toEqual(messages);
		expect(convertToLlm(messages).map(llmText)).toEqual([
			"before",
			"earlier continuation",
			"non-goal custom",
			"latest continuation",
			"after",
		]);
	});

	test("is idempotent across filtering and conversion", () => {
		const messages: AgentMessage[] = [
			goalContinuation("earlier continuation", 1),
			customMessage("non-goal custom", 2),
			goalContinuation("latest continuation", 3),
		];

		const filtered = filterContextExcludedMessages(messages);

		expect(filterContextExcludedMessages(filtered)).toEqual(filtered);
		expect(convertToLlm(filtered)).toEqual(convertToLlm(messages));
	});
});

describe("goal-continuation call-site consistency (300-message fixture)", () => {
	const FIXTURE_CONTINUATIONS = 300;
	const FIRST_CONTINUATION = "goal continuation 0";
	const LIVE_CONTINUATION = `goal continuation ${FIXTURE_CONTINUATIONS - 1}`;

	function buildMassFixture(): AgentMessage[] {
		const messages: AgentMessage[] = [];
		for (let index = 0; index < FIXTURE_CONTINUATIONS; index++) {
			messages.push({ role: "user", content: `user turn ${index}`, timestamp: index * 3 });
			messages.push(goalContinuation(`goal continuation ${index}`, index * 3 + 1));
			messages.push(fixtureAssistantMessage(`assistant reply ${index}`, index * 3 + 2));
		}
		return messages;
	}

	function buildMassFixtureEntries(): SessionEntry[] {
		const entries: SessionEntry[] = [];
		let parentId: string | null = null;
		for (let index = 0; index < FIXTURE_CONTINUATIONS; index++) {
			const userId = `mass-user-${index}`;
			entries.push({
				type: "message",
				id: userId,
				parentId,
				timestamp: new Date(1_700_000_000_000 + index * 3).toISOString(),
				message: { role: "user", content: `user turn ${index}`, timestamp: index * 3 },
			});
			const continuationId = `mass-continuation-${index}`;
			entries.push({
				type: "custom_message",
				id: continuationId,
				parentId: userId,
				timestamp: new Date(1_700_000_000_000 + index * 3 + 1).toISOString(),
				customType: GOAL_CONTINUATION_MESSAGE_TYPE,
				content: `goal continuation ${index}`,
				display: false,
			});
			const assistantId = `mass-assistant-${index}`;
			entries.push({
				type: "message",
				id: assistantId,
				parentId: continuationId,
				timestamp: new Date(1_700_000_000_000 + index * 3 + 2).toISOString(),
				message: fixtureAssistantMessage(`assistant reply ${index}`, index * 3 + 2),
			});
			parentId = assistantId;
		}
		return entries;
	}

	test("convertToLlm emits all 300 continuation-derived user messages in order", () => {
		const fixture = buildMassFixture();

		const converted = convertToLlm(fixture);

		expect(converted).toHaveLength(fixture.length);
		const continuationDerived = converted.filter((message) => llmText(message).startsWith("goal continuation"));
		expect(continuationDerived).toHaveLength(FIXTURE_CONTINUATIONS);
		expect(continuationDerived.every((message) => message.role === "user")).toBe(true);
		expect(llmText(continuationDerived[0])).toBe(FIRST_CONTINUATION);
		expect(llmText(continuationDerived[FIXTURE_CONTINUATIONS - 1])).toBe(LIVE_CONTINUATION);
	});

	test("filterContextExcludedMessages does not undercount the transport conversion", () => {
		const fixture = buildMassFixture();
		const continuations = fixture.filter(
			(message) => message.role === "custom" && message.customType === GOAL_CONTINUATION_MESSAGE_TYPE,
		);
		expect(continuations).toHaveLength(FIXTURE_CONTINUATIONS);

		const filtered = filterContextExcludedMessages(fixture);

		expect(filtered).toHaveLength(fixture.length);
		expect(continuationContents(filtered)).toEqual(continuationContents(fixture));

		// Token accounting must match what the provider actually receives; any
		// context-side drop would understate the request the transport builds.
		expect(estimateContextTokens(filtered).tokens).toBe(estimateContextTokens(fixture).tokens);
		expect(convertToLlm(filtered)).toHaveLength(convertToLlm(fixture).length);
	});

	test("prepareCompaction still succeeds on the flooded fixture and counts every continuation", () => {
		const entries = buildMassFixtureEntries();
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100 };

		const preparation = prepareCompaction(entries, settings);

		expect(preparation).toBeDefined();
		const contextMessages = buildSessionContext(entries).messages;
		const unfilteredTokens = estimateContextTokens(contextMessages).tokens;
		expect(estimateContextTokens(filterContextExcludedMessages(contextMessages)).tokens).toBe(unfilteredTokens);
		expect(preparation!.tokensBefore).toBe(unfilteredTokens);
	});

	test("branch summarization still sees every goal-continuation entry", () => {
		const entries = buildMassFixtureEntries();

		const preparation = prepareBranchEntries(entries);

		expect(isContextExcludedCustomMessage(GOAL_CONTINUATION_MESSAGE_TYPE)).toBe(false);
		const visibleContinuations = preparation.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === GOAL_CONTINUATION_MESSAGE_TYPE,
		);
		expect(visibleContinuations).toHaveLength(FIXTURE_CONTINUATIONS);
		const visibleContents = visibleContinuations.map((message) => message.content);
		expect(visibleContents).toContain(FIRST_CONTINUATION);
		expect(visibleContents).toContain(LIVE_CONTINUATION);
	});
});
