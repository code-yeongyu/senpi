import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../../../src/core/compaction/index.ts";
import {
	createRequiredCompactionFallback,
	type DeterministicFallbackDiagnostic,
} from "../../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";
import { flushCompactionLogs } from "../../../src/core/extensions/builtin/compaction/log.ts";
import { hasUnsafeRetainedContent } from "../../../src/core/extensions/builtin/compaction/retained-message-safety.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

const settings = {
	...DEFAULT_COMPACTION_SETTINGS,
	reserveTokens: 16_000,
	keepRecentTokens: 2_000,
};

// senpi#8566: a normal reasoning-effort change becomes a `configurationUpdate`
// runtime message. Normal request conversion accepts it (messages.ts), but the
// retained-suffix safety checker rejected it through its default branch, so the
// deterministic compaction fallback failed with `unsafe-retained-content`.
describe("issue #8566: configurationUpdate in the retained suffix", () => {
	afterEach(async () => {
		await flushCompactionLogs();
	});

	it("accepts the valid configurationUpdate shape from the issue report", () => {
		// Given: the exact projected message from the report (a high-effort change).
		const message = {
			role: "configurationUpdate",
			content: [],
			effort: "high",
			timestamp: 1789968476664,
		} as unknown as AgentMessage;

		// When/Then: a valid runtime configuration message is replay-safe.
		expect(hasUnsafeRetainedContent([message])).toBe(false);
	});

	it.each([
		["non-enum effort", { role: "configurationUpdate", content: [], effort: "turbo", timestamp: 1789968476664 }],
		["missing effort", { role: "configurationUpdate", content: [], timestamp: 1789968476664 }],
		["non-string effort", { role: "configurationUpdate", content: [], effort: 3, timestamp: 1789968476664 }],
		[
			"non-empty content",
			{
				role: "configurationUpdate",
				content: [{ type: "text", text: "stowaway" }],
				effort: "high",
				timestamp: 1789968476664,
			},
		],
		["non-array content", { role: "configurationUpdate", content: "high", effort: "high", timestamp: 1789968476664 }],
		["missing timestamp", { role: "configurationUpdate", content: [], effort: "high" }],
		["non-finite timestamp", { role: "configurationUpdate", content: [], effort: "high", timestamp: Number.NaN }],
	])("still rejects a malformed configurationUpdate (%s)", (_name, message) => {
		expect(hasUnsafeRetainedContent([message as unknown as AgentMessage])).toBe(true);
	});

	it("accepts a projected configuration_update entry in the live session context", () => {
		// Given: a session with a reasoning-effort change persisted as a
		// `configuration_update` entry, plus a complete tool-call/result pair.
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "Continue the implementation", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Working on it.", { timestamp: 2 }));
		const callId = manager.appendMessage({
			...fauxAssistantMessage("", { timestamp: 3, stopReason: "toolUse" }),
			content: [{ type: "toolCall", id: "eval-latest", name: "eval", arguments: { code: "print(result)" } }],
			usage: {
				input: 1_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "eval-latest",
			toolName: "eval",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 4,
		};
		manager.appendMessage(result);
		manager.appendConfigurationUpdate("high");
		void callId;

		// When: the live context is projected and converted for the provider.
		const messages = convertToLlm(manager.buildSessionContext().messages);

		// Then: the projected configurationUpdate keeps the producer shape, and the
		// whole context is replay-safe.
		const update = messages.find((message) => message.role === "configurationUpdate");
		expect(update).toMatchObject({ content: [], effort: "high" });
		expect(typeof update?.timestamp).toBe("number");
		expect(hasUnsafeRetainedContent(messages)).toBe(false);
	});

	it("keeps the latest reasoning configuration in the retained suffix after a deterministic fallback", () => {
		// Given: a long session whose newest entry is a reasoning-effort change,
		// preceded by a complete tool-call/result pair.
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "Continue the implementation", timestamp: 1 });
		for (let index = 0; index < 20; index++) {
			manager.appendMessage(fauxAssistantMessage("historical context ".repeat(100), { timestamp: index + 2 }));
		}
		manager.appendMessage({
			...fauxAssistantMessage("", { timestamp: 22, stopReason: "toolUse" }),
			content: [{ type: "toolCall", id: "eval-latest", name: "eval", arguments: { code: "print(result)" } }],
			usage: {
				input: 1_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "eval-latest",
			toolName: "eval",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 23,
		};
		manager.appendMessage(result);
		manager.appendConfigurationUpdate("high");

		// When: summarization fails, the deterministic fallback applies, and the
		// session continues from the retained suffix.
		const branch = manager.getBranch();
		const preparation = prepareCompaction(branch, settings, true);
		if (!preparation) throw new Error("Expected a compactable transcript");
		const diagnostics: DeterministicFallbackDiagnostic = {};
		const fallback = createRequiredCompactionFallback(
			preparation,
			400_000,
			"summarization-empty-summary",
			{},
			branch,
			diagnostics,
		);
		expect(fallback, JSON.stringify(diagnostics)).toBeDefined();
		expect(diagnostics.rejectionReason).toBeUndefined();
		if (!fallback) return;
		manager.appendCompaction(
			fallback.summary,
			fallback.firstKeptEntryId,
			fallback.tokensBefore,
			fallback.details,
			true,
		);
		const messages = convertToLlm(manager.buildSessionContext().messages);

		// Then: the retained suffix still carries the latest reasoning
		// configuration instead of omitting it as not replay-safe, and the
		// complete tool-call/result pair survives alongside it.
		const update = messages.find((message) => message.role === "configurationUpdate");
		expect(update).toMatchObject({ content: [], effort: "high" });
		expect(messages.some((message) => message.role === "assistant")).toBe(true);
		const output = messages.find((message) => message.role === "toolResult");
		expect(output).toMatchObject({ toolCallId: "eval-latest", isError: false });
		expect(
			messages.some(
				(message) =>
					message.role === "user" &&
					typeof message.content === "string" &&
					message.content.includes("[message omitted from retained context: not replay-safe]"),
			),
		).toBe(false);
		expect(hasUnsafeRetainedContent(messages)).toBe(false);
	});
});
