import { readFileSync } from "node:fs";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../../../src/core/compaction/index.ts";
import {
	createRequiredCompactionFallback,
	type DeterministicFallbackDiagnostic,
} from "../../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { flushCompactionLogs } from "../../../src/core/extensions/builtin/compaction/log.ts";
import {
	isAutomaticCompactionBlocked,
	REJECTED_RECOVERY_ENTRY,
} from "../../../src/core/extensions/builtin/compaction/rejected-recovery.ts";
import { hasUnsafeRetainedContent } from "../../../src/core/extensions/builtin/compaction/retained-message-safety.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const settings = {
	...DEFAULT_COMPACTION_SETTINGS,
	reserveTokens: 16_000,
	keepRecentTokens: 2_000,
};

// #3060: 246 persisted entries, with a ~5 KB newest eval result (1 KB text plus details).
function seedLongSession(manager: SessionManager, malformed = false, epoch = 0): string {
	manager.appendMessage({ role: "user", content: "Continue the implementation", timestamp: epoch + 1 });
	for (let index = 0; index < 243; index++) {
		manager.appendMessage(fauxAssistantMessage("historical context ".repeat(330), { timestamp: epoch + index + 2 }));
	}
	const boundary = manager.appendMessage({
		...fauxAssistantMessage("", { timestamp: epoch + 245, stopReason: "toolUse" }),
		content: [{ type: "toolCall", id: "eval-latest", name: "eval", arguments: { code: "print(result)" } }],
		usage: {
			input: 386_800,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 386_800,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "eval-latest",
		toolName: "eval",
		content: [{ type: "text", text: "result ".repeat(146) }],
		details: { result: { output: { text: "detail ".repeat(540) } } },
		isError: false,
		timestamp: epoch + 246,
	};
	if (malformed) Reflect.set(result, "isError", "invalid");
	manager.appendMessage(result);
	return boundary;
}

function recover(manager: SessionManager, boundary: string) {
	const branch = manager.getBranch();
	const preparation = prepareCompaction(branch, settings, true);
	if (!preparation) throw new Error("Expected a compactable transcript");
	const diagnostics: DeterministicFallbackDiagnostic = {};
	const result = createRequiredCompactionFallback(
		{ ...preparation, firstKeptEntryId: boundary },
		400_000,
		"summarization-empty-summary",
		{},
		branch,
		diagnostics,
	);
	return { result, diagnostics };
}

describe("issue #3060: unsafe newest retained message", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		await flushCompactionLogs();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("replaces the unsafe newest result in replay without rewriting the persisted transcript", async () => {
		// Given: the newest entry poisons all 246 candidate suffixes on the baseline.
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const manager = harness.sessionManager;
		const boundary = seedLongSession(manager, true);
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected a persisted fixture");
		const original = readFileSync(file, "utf8");
		expect(manager.getBranch()).toHaveLength(246);
		const newest = manager.getBranch().at(-1);
		expect(Buffer.byteLength(JSON.stringify(newest))).toBeGreaterThan(4_500);
		expect(Buffer.byteLength(JSON.stringify(newest))).toBeLessThan(5_500);

		// When: required summarization cannot produce a summary.
		const { result, diagnostics } = recover(manager, boundary);
		expect(
			result,
			JSON.stringify({
				reason: diagnostics.rejectionReason,
				candidatesChecked: diagnostics.candidatesChecked,
				newest: diagnostics.candidateRejections?.at(-1),
			}),
		).toBeDefined();
		if (!result) return;
		manager.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, true);
		// A later ordinary checkpoint must not resurrect the original unsafe payload.
		manager.appendCompaction("Later summary", result.firstKeptEntryId, 1_000);

		// Then: both the live projection and a reopened session have a replay-safe pair.
		for (const context of [manager.buildSessionContext(), SessionManager.open(file).buildSessionContext()]) {
			const messages = convertToLlm(context.messages);
			expect(hasUnsafeRetainedContent(messages)).toBe(false);
			const call = messages.find((message) => message.role === "assistant");
			expect(call).toMatchObject({ content: [{ type: "toolCall", id: "eval-latest" }] });
			const output = messages.find((message) => message.role === "toolResult");
			expect(output).toMatchObject({ toolCallId: "eval-latest", isError: true });
			expect(output).not.toHaveProperty("details");
		}
		expect(readFileSync(file, "utf8").startsWith(original)).toBe(true);
		expect(JSON.stringify(manager.getBranch().find((entry) => entry.id === newest?.id))).toBe(JSON.stringify(newest));
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "new-result",
			toolName: "eval",
			content: [{ type: "text", text: "new output" }],
			isError: false,
			timestamp: 247,
		});
		expect(manager.buildSessionContext().messages.at(-1)).toMatchObject({ toolCallId: "new-result", isError: false });
	});

	it.each([
		["Buffer", () => Buffer.from("serializable detail")],
		[
			"class",
			() =>
				new (class Detail {
					value = "serializable detail";
				})(),
		],
		["Map", () => new Map([["value", "serializable detail"]])],
		[
			"getter",
			() => ({
				get value() {
					return "serializable detail";
				},
			}),
		],
	])("classifies live %s details identically to the persisted JSON", (_name, makeDetails) => {
		// Given: persistence normalizes these live tool values, rather than rejecting them.
		const manager = SessionManager.inMemory();
		const boundary = seedLongSession(manager);
		const branch = manager.getBranch();
		const newest = branch.at(-1);
		if (newest?.type !== "message" || newest.message.role !== "toolResult") throw new Error("Expected eval result");
		Reflect.set(newest.message, "details", makeDetails());
		const originalDetails = newest.message.details;
		const preparation = prepareCompaction(branch, settings, true);
		if (!preparation) throw new Error("Expected preparation");
		const recoverBranch = (entries: typeof branch) =>
			createRequiredCompactionFallback(
				{ ...preparation, firstKeptEntryId: boundary },
				400_000,
				"summarization-empty-summary",
				{},
				entries,
			);

		// When: comparing the same message before and after the session JSON round trip.
		const persisted = JSON.parse(JSON.stringify(branch)) as typeof branch;
		const diskResult = recoverBranch(persisted);
		expect(diskResult).toBeDefined();
		const liveResult = recoverBranch(branch);

		// Then: no safe detail is omitted, and the caller's objects remain untouched.
		expect(liveResult).toEqual(diskResult);
		expect(newest.message.details).toBe(originalDetails);
	});

	it("attempts an impossible automatic recovery once across repeated triggers and session reopen", async () => {
		// Given: no suffix can fit because the last complete pair is itself over budget.
		const options = {
			models: [{ id: "faux-3060", contextWindow: 400_000, maxTokens: 1_000 }],
			settings: { compaction: settings, retry: { enabled: false } },
			extensionFactories: [compactionExtension],
		};
		const harness = await createHarness({ ...options, persistSession: true });
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "already summarized", timestamp: 0 });
		const previousBoundary = harness.sessionManager.appendMessage(
			fauxAssistantMessage("old result", { timestamp: 0 }),
		);
		harness.sessionManager.appendCompaction("Earlier checkpoint", previousBoundary, 1_000);
		seedLongSession(harness.sessionManager, false, Date.now() + 1);
		harness.sessionManager.appendMessage({ role: "user", content: "huge input ".repeat(170_000), timestamp: 247 });
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		// #3061: the provider succeeds; only the retained context is impossible.
		harness.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("A usable summary.")));
		await harness.session.bindExtensions({});
		const file = harness.sessionManager.getSessionFile();
		if (!file) throw new Error("Expected session file");

		// When: the real pre-prompt trigger is called again without changing its rejected transcript.
		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(harness.session.prompt("continue")).rejects.toThrow(/compaction/i);
			await harness.session.waitForSettledSessionWork();
			harness.sessionManager.appendCustomEntry("status-update", { attempt });
		}
		const reopened = await createHarness({
			...options,
			siblingOf: harness,
			sessionManager: SessionManager.open(file),
		});
		harnesses.push(reopened);
		await reopened.session.bindExtensions({});
		expect(
			isAutomaticCompactionBlocked(
				reopened.sessionManager.getBranch(),
				reopened.getModel(),
				reopened.settingsManager.getCompactionSettings(),
			),
		).toBe(true);
		await expect(reopened.session.prompt("continue")).rejects.toThrow(/compaction/i);
		await reopened.session.waitForSettledSessionWork();

		// Then: event counts prove suppression; no timers or circuit-breaker cooldowns are involved.
		const events = [...harness.events, ...reopened.events];
		expect(events.filter((event) => event.type === "compaction_start")).toHaveLength(1);
		const notices = events.filter((event) => event.type === "compaction_end" && event.errorMessage);
		expect(notices).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);

		// Explicit retry remains available, and a new transcript entry releases the latch.
		await expect(reopened.session.compact()).rejects.toThrow(/compaction/i);
		expect(reopened.eventsOfType("compaction_start")).toHaveLength(1);
		reopened.sessionManager.appendMessage({
			role: "user",
			content: "new oversized input ".repeat(90_000),
			timestamp: 248,
		});
		reopened.session.agent.state.messages = reopened.sessionManager.buildSessionContext().messages;
		reopened.setResponses([fauxAssistantMessage("A usable summary.")]);
		await expect(reopened.session.prompt("continue")).rejects.toThrow(/compaction/i);
		await reopened.session.waitForSettledSessionWork();
		expect(reopened.eventsOfType("compaction_start")).toHaveLength(2);
		expect(reopened.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("retries automatic compaction after a transient summary failure and rejected fallback", async () => {
		// #3061 Given: a short real summary fits, but the deterministic marker does not.
		const harness = await createHarness({
			models: [{ id: "faux-3061", contextWindow: 400_000, maxTokens: 1_000 }],
			settings: { compaction: settings, retry: { enabled: false } },
			extensionFactories: [compactionExtension],
			persistSession: true,
		});
		harnesses.push(harness);
		seedLongSession(harness.sessionManager);
		const boundary = harness.sessionManager.appendMessage({
			role: "user",
			content: "input ".repeat(255_933),
			timestamp: 247,
		});
		const fallback = recover(harness.sessionManager, boundary);
		expect(fallback.result, JSON.stringify(fallback.diagnostics)).toBeUndefined();
		expect(fallback.diagnostics.rejectionReason).toBe("retained-token-budget-exceeded");
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "upstream_stream_truncated: temporary provider interruption",
			}),
		]);
		await harness.session.bindExtensions({});

		// When: the first real trigger fails, then the provider recovers on the next one.
		await expect(harness.session.prompt("continue")).rejects.toThrow(/compaction/i);
		await harness.session.waitForSettledSessionWork();
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(1);
		harness.setResponses([fauxAssistantMessage("Summary."), fauxAssistantMessage("Continued.")]);
		await harness.session.prompt("continue");
		await harness.session.waitForSettledSessionWork();

		// Then: the recovered provider is reached and a real checkpoint is accepted.
		expect(harness.eventsOfType("compaction_end").filter((event) => event.accepted)).toHaveLength(1);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === REJECTED_RECOVERY_ENTRY),
		).toHaveLength(0);
	});

	it("preserves a deterministic latch when an explicit retry fails with a different failure kind", async () => {
		// #3061 Given: successful summarization proves this retained turn cannot fit.
		const harness = await createHarness({
			models: [{ id: "faux-3061-kind", contextWindow: 400_000, maxTokens: 1_000 }],
			settings: { compaction: settings, retry: { enabled: false } },
			extensionFactories: [compactionExtension],
			persistSession: true,
		});
		harnesses.push(harness);
		seedLongSession(harness.sessionManager);
		harness.sessionManager.appendMessage({ role: "user", content: "huge input ".repeat(170_000), timestamp: 247 });
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("A usable summary.")]);
		await harness.session.bindExtensions({});
		await expect(harness.session.prompt("continue")).rejects.toThrow(/compaction/i);
		await harness.session.waitForSettledSessionWork();
		const rejections = () =>
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === REJECTED_RECOVERY_ENTRY);
		const terminalRecords = rejections();
		expect(terminalRecords).toHaveLength(1);
		expect(terminalRecords[0]).toMatchObject({ data: { failureKind: "unsafe-retained-content" } });

		// When: an explicit retry bypasses the latch but encounters a provider failure.
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "upstream_stream_truncated: temporary provider interruption",
			}),
		]);
		await expect(harness.session.compact()).rejects.toThrow(/compaction/i);
		await harness.session.waitForSettledSessionWork();

		// Then: a different failure neither overwrites nor clears the context latch.
		expect(rejections()).toEqual(terminalRecords);
		expect(
			isAutomaticCompactionBlocked(
				harness.sessionManager.getBranch(),
				harness.getModel(),
				harness.settingsManager.getCompactionSettings(),
			),
		).toBe(true);
		const starts = harness.eventsOfType("compaction_start").length;
		const notices = harness.eventsOfType("compaction_end").length;
		await expect(harness.session.prompt("continue")).rejects.toThrow(/compaction/i);
		await harness.session.waitForSettledSessionWork();
		expect(harness.eventsOfType("compaction_start")).toHaveLength(starts);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(notices);
	});
});
