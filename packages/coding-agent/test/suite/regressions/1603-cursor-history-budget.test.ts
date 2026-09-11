import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { measureCursorHistorySerializedBytes, measureCursorModelInputSerializedBytes } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	forgetCursorConversationContextLimit,
	getCursorConversationContextLimit,
	recordCursorConversationContextLimit,
	setCursorActiveConversationWire,
} from "../../../../ai/src/cursor/conversation-context-limit.ts";
import {
	CURSOR_TOOL_RESULT_MAX_BYTES,
	CURSOR_TOOL_RESULT_MAX_CHARS,
	resolveCursorAdmissionMaxBytes,
	truncateToolResultBodies,
} from "../../../src/core/agent-session.ts";
import { convertToLlmForTransport } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

const CODEWORD = "BANANA7";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

function assistantText(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "cursor-agent",
		provider: "cursor",
		model: "kimi-k3",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	} as AgentMessage;
}

function toolFreeConversationExceedingAggregateCap(): AgentMessage[] {
	const filler = "The quick brown fox jumps over the lazy dog. ".repeat(700).slice(0, 30_000);
	return [
		userMessage(`${filler}\nRemember this codeword: ${CODEWORD}.`),
		assistantText("OK"),
		userMessage("What codeword did I ask you to remember?"),
	];
}

function reviewerCounterCaseMessages(): AgentMessage[] {
	// 410,000 characters is ~102,500 tokens under the repo-wide 4-chars-per-token
	// estimate. The turns[] display copy doubles the serialized full wire past
	// the 800,000-byte server budget while the model input stays inside it, so
	// the aggregate turn-dropping pass must not run on the full-wire number.
	const longText = "The quick brown fox jumps over the lazy dog. ".repeat(10_000).slice(0, 410_000);
	return [
		userMessage(`${longText}\nRemember this codeword: ${CODEWORD}.`),
		assistantText("Acknowledged."),
		userMessage("What codeword did I ask you to remember?"),
	];
}

function convert(candidate: AgentMessage[]) {
	return convertToLlmForTransport(candidate, { blockImages: false, alwaysKeepNewest: 1 });
}

function serializedText(messages: AgentMessage[]): string {
	return JSON.stringify(convert(messages));
}

const SERVER_REPORTED_KIMI_K3_LIMIT = 200_000;

describe("1603 cursor history budget", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps the earliest user turn when the conversation contains no tool results", () => {
		const messages = toolFreeConversationExceedingAggregateCap();

		const { messages: next } = truncateToolResultBodies(
			messages,
			CURSOR_TOOL_RESULT_MAX_CHARS,
			resolveCursorAdmissionMaxBytes(SERVER_REPORTED_KIMI_K3_LIMIT),
			convert,
		);

		if (!next) throw new Error("expected messages");
		expect(serializedText(next)).toContain(CODEWORD);
	});

	it("does not drop turns from a tool-free conversation", () => {
		const messages = toolFreeConversationExceedingAggregateCap();

		const { messages: next } = truncateToolResultBodies(
			messages,
			CURSOR_TOOL_RESULT_MAX_CHARS,
			resolveCursorAdmissionMaxBytes(SERVER_REPORTED_KIMI_K3_LIMIT),
			convert,
		);

		if (!next) throw new Error("expected messages");
		expect(next.length).toBe(messages.length);
	});

	it("falls back to the legacy cap until the server reports a limit", () => {
		expect(resolveCursorAdmissionMaxBytes(undefined)).toBe(CURSOR_TOOL_RESULT_MAX_BYTES);
		expect(resolveCursorAdmissionMaxBytes(0)).toBe(CURSOR_TOOL_RESULT_MAX_BYTES);
	});

	it("drops back to exactly the legacy cap when the conversation reports an explicit zero", () => {
		const session = "1603-explicit-zero-session";
		try {
			recordCursorConversationContextLimit(session, session, SERVER_REPORTED_KIMI_K3_LIMIT);
			expect(resolveCursorAdmissionMaxBytes(getCursorConversationContextLimit(session, session))).toBe(
				resolveCursorAdmissionMaxBytes(SERVER_REPORTED_KIMI_K3_LIMIT),
			);

			// Cursor's checkpoint reports an explicit zero: that invalidates the earlier
			// 200000-token report instead of preserving it, so admission must fall back
			// to exactly 50000 bytes.
			recordCursorConversationContextLimit(session, session, 0);

			expect(getCursorConversationContextLimit(session, session)).toBeUndefined();
			expect(resolveCursorAdmissionMaxBytes(getCursorConversationContextLimit(session, session))).toBe(
				CURSOR_TOOL_RESULT_MAX_BYTES,
			);
		} finally {
			forgetCursorConversationContextLimit(session);
		}
	});

	it("never shrinks the budget below the legacy cap", () => {
		expect(resolveCursorAdmissionMaxBytes(1)).toBe(CURSOR_TOOL_RESULT_MAX_BYTES);
	});

	it("scales the budget from the server-reported limit", () => {
		expect(resolveCursorAdmissionMaxBytes(SERVER_REPORTED_KIMI_K3_LIMIT)).toBe(SERVER_REPORTED_KIMI_K3_LIMIT * 4);
	});

	it("keeps the sentinel when only the duplicated turns envelope exceeds the aggregate cap", () => {
		const messages = reviewerCounterCaseMessages();
		const budget = resolveCursorAdmissionMaxBytes(SERVER_REPORTED_KIMI_K3_LIMIT);
		const converted = convert(messages);
		const activeUserMessageIndex = converted.at(-1)?.role === "user" ? converted.length - 1 : -1;

		// The reviewer's counter-case only overflows the full wire; the model input
		// the aggregate gate must compare against fits the same budget.
		expect(measureCursorModelInputSerializedBytes(converted, activeUserMessageIndex)).toBeLessThan(budget);
		expect(measureCursorHistorySerializedBytes(converted, activeUserMessageIndex)).toBeGreaterThan(budget);

		const { messages: next, changed } = truncateToolResultBodies(
			messages,
			CURSOR_TOOL_RESULT_MAX_CHARS,
			budget,
			convert,
		);

		expect(changed).toBe(false);
		if (!next) throw new Error("expected messages");
		expect(next.length).toBe(messages.length);
		expect(serializedText(next)).toContain(CODEWORD);
	});

	it("bootstraps a replacement conversation at exactly the legacy cap", () => {
		const session = "1603-bootstrap-session";
		const reported = "1603-reported-conversation";
		const replacement = "1603-replacement-conversation";
		try {
			recordCursorConversationContextLimit(session, reported, SERVER_REPORTED_KIMI_K3_LIMIT);

			expect(resolveCursorAdmissionMaxBytes(getCursorConversationContextLimit(session, replacement))).toBe(
				CURSOR_TOOL_RESULT_MAX_BYTES,
			);
			expect(resolveCursorAdmissionMaxBytes(getCursorConversationContextLimit(session, reported))).toBe(
				resolveCursorAdmissionMaxBytes(SERVER_REPORTED_KIMI_K3_LIMIT),
			);
		} finally {
			forgetCursorConversationContextLimit(session);
		}
	});

	it("does not leak a reported limit into the session's next conversation through the installed transform", async () => {
		const harness = await createHarness({ provider: "cursor", models: [{ id: "cursor", contextWindow: 100_000 }] });
		harnesses.push(harness);
		const sessionId = harness.sessionManager.getSessionId();
		// sdk.ts wires the agent's session id from the session manager; the provider
		// records checkpoints under it, so admission must look it up the same way.
		harness.agent.sessionId = sessionId;
		const messages = reviewerCounterCaseMessages();
		const transform = harness.agent.transformContext;
		if (!transform) throw new Error("expected the installed Cursor transform");

		// Conversation A reported its 200k window; the session's own conversation has
		// not reported yet, so its first request must admit against exactly 50,000.
		recordCursorConversationContextLimit(sessionId, "conversation-a", SERVER_REPORTED_KIMI_K3_LIMIT);
		expect(resolveCursorAdmissionMaxBytes(getCursorConversationContextLimit(sessionId, sessionId))).toBe(
			CURSOR_TOOL_RESULT_MAX_BYTES,
		);
		const bootstrapped = await transform(messages.slice());
		expect(bootstrapped.length).toBeLessThan(messages.length);
		expect(serializedText(bootstrapped)).not.toContain(CODEWORD);

		// Once the admitted conversation reports, its server limit sizes admission.
		recordCursorConversationContextLimit(sessionId, sessionId, SERVER_REPORTED_KIMI_K3_LIMIT);
		const admitted = await transform(messages.slice());
		expect(admitted.length).toBe(messages.length);
		expect(serializedText(admitted)).toContain(CODEWORD);
	});

	it("admits at exactly the legacy cap through the installed transform after an explicit zero", async () => {
		const harness = await createHarness({ provider: "cursor", models: [{ id: "cursor", contextWindow: 100_000 }] });
		harnesses.push(harness);
		const sessionId = harness.sessionManager.getSessionId();
		harness.agent.sessionId = sessionId;
		const messages = reviewerCounterCaseMessages();
		const transform = harness.agent.transformContext;
		if (!transform) throw new Error("expected the installed Cursor transform");
		try {
			recordCursorConversationContextLimit(sessionId, sessionId, SERVER_REPORTED_KIMI_K3_LIMIT);
			const admitted = await transform(messages.slice());
			expect(admitted.length).toBe(messages.length);
			expect(serializedText(admitted)).toContain(CODEWORD);

			// The conversation's later checkpoint reports an explicit zero, which must
			// invalidate its own earlier report: admission falls back to exactly 50000
			// bytes and the reviewer's counter-case collapses again.
			recordCursorConversationContextLimit(sessionId, sessionId, 0);
			expect(resolveCursorAdmissionMaxBytes(getCursorConversationContextLimit(sessionId, sessionId))).toBe(
				CURSOR_TOOL_RESULT_MAX_BYTES,
			);
			const reverted = await transform(messages.slice());
			expect(reverted.length).toBeLessThan(messages.length);
			expect(serializedText(reverted)).not.toContain(CODEWORD);
		} finally {
			forgetCursorConversationContextLimit(sessionId);
		}
	});

	it("keeps the reported budget after Cursor rotates the conversation's wire id", async () => {
		const harness = await createHarness({ provider: "cursor", models: [{ id: "cursor", contextWindow: 100_000 }] });
		harnesses.push(harness);
		const sessionId = harness.sessionManager.getSessionId();
		harness.agent.sessionId = sessionId;
		const messages = reviewerCounterCaseMessages();
		const transform = harness.agent.transformContext;
		if (!transform) throw new Error("expected the installed Cursor transform");

		const firstWire = `${sessionId}-wire-1`;
		const rotatedWire = `${sessionId}-wire-2`;
		try {
			// The provider publishes the wire each attempt and records the limit that
			// wire's checkpoint reported; the session id is the base identity admission
			// names, so this is the provider's post-rotation sequence.
			setCursorActiveConversationWire(sessionId, sessionId, firstWire);
			recordCursorConversationContextLimit(sessionId, firstWire, SERVER_REPORTED_KIMI_K3_LIMIT);

			// Cursor rotates the wire id in-call. The rotated conversation starts
			// unknown, so admission falls back to exactly the bootstrap cap until its
			// own positive checkpoint reports.
			setCursorActiveConversationWire(sessionId, sessionId, rotatedWire);
			expect(resolveCursorAdmissionMaxBytes(getCursorConversationContextLimit(sessionId, sessionId))).toBe(
				CURSOR_TOOL_RESULT_MAX_BYTES,
			);

			// Its checkpoint reported the server limit; admission must size from that
			// budget instead of collapsing the history at 50,000 bytes. All 3 messages
			// and the sentinel survive.
			recordCursorConversationContextLimit(sessionId, rotatedWire, SERVER_REPORTED_KIMI_K3_LIMIT);
			expect(resolveCursorAdmissionMaxBytes(getCursorConversationContextLimit(sessionId, sessionId))).toBe(
				resolveCursorAdmissionMaxBytes(SERVER_REPORTED_KIMI_K3_LIMIT),
			);
			const admitted = await transform(messages.slice());
			expect(admitted.length).toBe(messages.length);
			expect(serializedText(admitted)).toContain(CODEWORD);
		} finally {
			forgetCursorConversationContextLimit(sessionId);
		}
	});
});
