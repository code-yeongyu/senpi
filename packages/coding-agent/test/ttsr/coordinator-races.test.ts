import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	claimAbort,
	createGenerationState,
	markUserCancelled,
	resolveDetection,
} from "../../src/core/extensions/builtin/ttsr/coordinator.ts";
import ttsrExtension from "../../src/core/extensions/builtin/ttsr/index.ts";
import { LEAK_ERROR_MESSAGE } from "../../src/core/extensions/builtin/ttsr/prompts.ts";
import {
	type DetectionResolution,
	type DetectorMatch,
	TTSR_INJECTION_CUSTOM_TYPE,
} from "../../src/core/extensions/builtin/ttsr/types.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../suite/harness.ts";

interface PersistedMessage {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
}

interface PersistedEntry {
	type?: string;
	customType?: string;
	message?: PersistedMessage;
	data?: { rules?: unknown; owner?: unknown };
}

function ctrlToken(name: string): string {
	return ["<", "|", name, "|", ">"].join("");
}

function makeMatch(rule: DetectorMatch["rule"]): DetectorMatch {
	return { rule, reason: `${rule} fired`, anomalyStartOffset: 12, garbageStartOffset: 12, detail: {} };
}

function mustResolve(
	direct: DetectorMatch | null,
	collapse: DetectorMatch | null,
	corroborated: DetectorMatch | null,
): DetectionResolution {
	const resolution = resolveDetection(direct, collapse, corroborated);
	if (resolution === null) throw new Error("expected a resolution");
	return resolution;
}

function readSessionEntries(harness: Harness): PersistedEntry[] {
	const file = harness.sessionManager.getSessionFile();
	if (typeof file !== "string") throw new Error("expected a persisted session file");
	return readFileSync(file, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const entry: PersistedEntry = JSON.parse(line);
			return entry;
		});
}

function activationRecords(entries: PersistedEntry[]): PersistedEntry[] {
	return entries.filter((entry) => entry.type === "custom" && entry.customType === "rule-activation");
}

function nudgeMessages(entries: PersistedEntry[]): PersistedEntry[] {
	return entries.filter((entry) => entry.type === "custom_message" && entry.customType === TTSR_INJECTION_CUSTOM_TYPE);
}

function assistantMessages(entries: PersistedEntry[]): PersistedMessage[] {
	const messages: PersistedMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "assistant") messages.push(entry.message);
	}
	return messages;
}

function mixedCorruption(): string {
	const wrapped = "!".repeat(500).match(/.{1,80}/g);
	if (wrapped === null) throw new Error("unreachable");
	return `analyzing the problem ${ctrlToken("close")} ${wrapped.join("\n")}`;
}

function leakStream(): string {
	const sep = ctrlToken("sep");
	return `Thinking... ${sep} ${sep} ${sep} ${sep} trailing garbage`;
}

describe("coordinator mixed-ownership matrix", () => {
	const matrix: Array<{
		name: string;
		direct: DetectorMatch | null;
		collapse: DetectorMatch | null;
		corroborated: DetectorMatch | null;
		owner: DetectionResolution["owner"];
		observed: readonly string[];
		retryMode: string;
	}> = [
		{
			name: "M-1/M-2/M-3/M-8 leak dominates with collapse observed",
			direct: makeMatch("control-token-leak"),
			collapse: makeMatch("collapse-repetition"),
			corroborated: null,
			owner: "control-token-leak",
			observed: ["control-token-leak", "collapse-repetition"],
			retryMode: "provider-error",
		},
		{
			name: "M-4/M-5 collapse owns when corroboration does not apply",
			direct: null,
			collapse: makeMatch("collapse-repetition"),
			corroborated: null,
			owner: "collapse-repetition",
			observed: ["collapse-repetition"],
			retryMode: "nudge",
		},
		{
			name: "M-6 corroboration reclassifies collapse to the leak owner",
			direct: null,
			collapse: makeMatch("collapse-repetition"),
			corroborated: makeMatch("control-token-leak"),
			owner: "control-token-leak",
			observed: ["control-token-leak", "collapse-repetition"],
			retryMode: "provider-error",
		},
		{
			name: "direct leak alone observes only the leak",
			direct: makeMatch("control-token-leak"),
			collapse: null,
			corroborated: null,
			owner: "control-token-leak",
			observed: ["control-token-leak"],
			retryMode: "provider-error",
		},
	];
	for (const row of matrix) {
		it(row.name, () => {
			const resolution = mustResolve(row.direct, row.collapse, row.corroborated);
			expect(resolution.owner).toBe(row.owner);
			expect(resolution.observedRules).toEqual(row.observed);
			expect(resolution.remediation.retryMode).toBe(row.retryMode);
		});
	}

	it("M-7/M-9 single-claim latch suppresses late detections", () => {
		const state = createGenerationState();
		expect(claimAbort(state, mustResolve(makeMatch("control-token-leak"), null, null))).toBe(true);
		for (let i = 0; i < 3; i += 1) {
			expect(claimAbort(state, mustResolve(null, makeMatch("collapse-repetition"), null))).toBe(false);
		}
		expect(state.abortOwner).toBe("control-token-leak");
	});

	it("user cancellation before any claim stands the generation down", () => {
		const state = createGenerationState();
		markUserCancelled(state);
		expect(
			claimAbort(state, mustResolve(makeMatch("control-token-leak"), makeMatch("collapse-repetition"), null)),
		).toBe(false);
		expect(state.abortClaimed).toBe(false);
		expect(state.abortOwner).toBeUndefined();
	});

	it("M-10 a fresh generation re-arms the latch after a claimed abort", () => {
		const resolution = mustResolve(makeMatch("control-token-leak"), makeMatch("collapse-repetition"), null);
		const first = createGenerationState();
		expect(claimAbort(first, resolution)).toBe(true);
		const rearmed = createGenerationState();
		expect(claimAbort(rearmed, resolution)).toBe(true);
		expect(rearmed.abortOwner).toBe("control-token-leak");
	});
});

describe("coordinator races through the session wiring", () => {
	let harness: Harness;

	afterEach(() => {
		harness.cleanup();
	});

	it("mixed token+flood stream yields one leak-owned abort, an error shell, and no nudge", async () => {
		harness = await createHarness({ extensionFactories: [ttsrExtension], persistSession: true });
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(mixedCorruption())]),
			fauxAssistantMessage([fauxText("clean answer")]),
		]);
		await harness.session.prompt("do work");
		const entries = readSessionEntries(harness);
		const assistants = assistantMessages(entries);
		expect(assistants[0]?.stopReason).toBe("error");
		expect(assistants[0]?.errorMessage).toBe(LEAK_ERROR_MESSAGE);
		expect(Array.isArray(assistants[0]?.content) ? assistants[0].content.length : -1).toBe(0);
		const records = activationRecords(entries);
		expect(records.length).toBe(1);
		expect(records[0]?.data?.owner).toBe("control-token-leak");
		expect(Array.isArray(records[0]?.data?.rules) ? records[0].data.rules : []).toEqual([
			"control-token-leak",
			"collapse-repetition",
		]);
		expect(nudgeMessages(entries).length).toBe(0);
		expect(harness.faux.getCallLog().length).toBe(2);
		expect(assistants.map((message) => getMessageText(message)).join("\n")).toContain("clean answer");
	});

	it("documents the remediation-window input gap: a racing user prompt cannot preempt the armed nudge", async () => {
		harness = await createHarness({ extensionFactories: [ttsrExtension], persistSession: true });
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(`steady reasoning ${"!".repeat(600)}`)]),
			fauxAssistantMessage([fauxText("after nudge")]),
		]);
		const controller = new AbortController();
		harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.stopReason === "aborted"
			) {
				harness.session.prompt("user interrupt", { signal: controller.signal }).catch(() => undefined);
			}
		});
		await harness.session.prompt("do work");
		await harness.session.waitForIdle();
		const entries = readSessionEntries(harness);
		expect(nudgeMessages(entries).length).toBe(1);
		const records = activationRecords(entries);
		expect(records.length).toBe(1);
		expect(records[0]?.data?.owner).toBe("collapse-repetition");
		expect(harness.faux.getCallLog().length).toBe(2);
		expect(getUserTexts(harness)).not.toContain("user interrupt");
		expect(
			assistantMessages(entries)
				.map((message) => getMessageText(message))
				.join("\n"),
		).toContain("after nudge");
		controller.abort();
	});

	it("session.abort during the retry backoff cancels remediation via session_abort", async () => {
		harness = await createHarness({
			extensionFactories: [ttsrExtension],
			persistSession: true,
			settings: { retry: { baseDelayMs: 50, maxRetries: 3 } },
		});
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(leakStream())]),
			fauxAssistantMessage([fauxText("should never stream")]),
		]);
		let onRetryStart: () => void = () => undefined;
		const retryStarted = new Promise<void>((resolve) => {
			onRetryStart = resolve;
		});
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") onRetryStart();
		});
		const prompting = harness.session.prompt("do work");
		await retryStarted;
		await harness.session.abort();
		await prompting;
		await harness.session.waitForIdle();
		expect(harness.eventsOfType("session_abort").length).toBe(1);
		const retryEnds = harness.eventsOfType("auto_retry_end");
		expect(retryEnds.length).toBe(1);
		expect(retryEnds[0]?.success).toBe(false);
		expect(harness.faux.getCallLog().length).toBe(1);
		const entries = readSessionEntries(harness);
		const assistants = assistantMessages(entries);
		expect(assistants.length).toBe(1);
		expect(assistants[0]?.stopReason).toBe("error");
		expect(assistants[0]?.errorMessage).toBe(LEAK_ERROR_MESSAGE);
		expect(activationRecords(entries).length).toBe(1);
		expect(nudgeMessages(entries).length).toBe(0);
	});

	it("a retry that leaks again re-arms the detectors and stays bounded", async () => {
		harness = await createHarness({
			extensionFactories: [ttsrExtension],
			persistSession: true,
			settings: { retry: { baseDelayMs: 50, maxRetries: 3 } },
		});
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(leakStream())]),
			fauxAssistantMessage([fauxThinking(leakStream())]),
			fauxAssistantMessage([fauxText("clean answer")]),
		]);
		await harness.session.prompt("do work");
		await harness.session.waitForIdle();
		expect(harness.faux.getCallLog().length).toBe(3);
		expect(harness.eventsOfType("auto_retry_start").length).toBe(2);
		const entries = readSessionEntries(harness);
		const assistants = assistantMessages(entries);
		expect(assistants.filter((m) => m.stopReason === "error" && m.errorMessage === LEAK_ERROR_MESSAGE).length).toBe(
			2,
		);
		expect(activationRecords(entries).length).toBe(2);
		expect(nudgeMessages(entries).length).toBe(0);
		expect(assistants.map((message) => getMessageText(message)).join("\n")).toContain("clean answer");
	});
});
