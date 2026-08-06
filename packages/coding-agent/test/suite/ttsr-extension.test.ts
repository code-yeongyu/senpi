import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import ttsrExtension from "../../src/core/extensions/builtin/ttsr/index.ts";
import { LEAK_ERROR_MESSAGE } from "../../src/core/extensions/builtin/ttsr/prompts.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { expectTtsrActivation } from "./ttsr-activation-assertions.ts";

const FABRICATED_TOOL_CALL_RULE_NAME = "fabricated-unavailable-tool-call";

interface PersistedMessage {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown[];
}

interface PersistedEntry {
	type?: string;
	customType?: string;
	message?: PersistedMessage;
}

function ctrlToken(name: string): string {
	return ["<", "|", name, "|", ">"].join("");
}

function readSessionLines(harness: Harness): string[] {
	const file = harness.sessionManager.getSessionFile();
	if (file === undefined) {
		throw new Error("expected a persisted session file");
	}
	return readFileSync(file, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0);
}

function readSessionEntries(harness: Harness): PersistedEntry[] {
	const entries: PersistedEntry[] = [];
	for (const line of readSessionLines(harness)) {
		const parsed: PersistedEntry = JSON.parse(line);
		entries.push(parsed);
	}
	return entries;
}

function blockField(block: unknown, kind: "text" | "thinking"): string | undefined {
	if (typeof block !== "object" || block === null) return undefined;
	if (!("type" in block) || block.type !== kind) return undefined;
	if (kind === "thinking" && "thinking" in block && typeof block.thinking === "string") return block.thinking;
	if (kind === "text" && "text" in block && typeof block.text === "string") return block.text;
	return undefined;
}

function streamText(message: PersistedMessage | undefined, kind: "text" | "thinking"): string {
	let combined = "";
	for (const block of message?.content ?? []) {
		combined += blockField(block, kind) ?? "";
	}
	return combined;
}

function ttsrNudges(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "custom")
		.filter((message) => message.customType === "ttsr-injection")
		.map((message) => (typeof message.content === "string" ? message.content : ""));
}

describe("fabricated unavailable-tool call remediation", () => {
	let harness: Harness;

	afterEach(() => {
		harness.cleanup();
	});

	it.each([
		'<unavailable-tool-call name="apply_patch">',
		'[Called tool "apply_patch" (no longer available in this session) with input: {}]',
	])("interrupts fabricated tool-call text and retries with an action-oriented nudge: %s", async (fabricated) => {
		harness = await createHarness({ extensionFactories: [ttsrExtension], persistSession: true });
		harness.setResponses([
			fauxAssistantMessage([fauxText(`${fabricated} inert imitation`)]),
			fauxAssistantMessage([fauxText("recovered with real tools")]),
		]);

		await harness.session.prompt("edit the file");

		expect(harness.faux.getCallLog()).toHaveLength(2);
		const nudges = ttsrNudges(harness);
		expect(nudges).toHaveLength(1);
		expect(nudges[0]).toContain(
			`<system-interrupt reason="rule_violation" rule="${FABRICATED_TOOL_CALL_RULE_NAME}">`,
		);
		expect(nudges[0]).toMatch(/call.*real tools|real tools.*redo/i);
		expect(getMessageText(harness.session.messages.at(-1))).toContain("recovered with real tools");
	});

	it("does not inspect thinking streams", async () => {
		harness = await createHarness({ extensionFactories: [ttsrExtension], persistSession: true });
		harness.setResponses([
			fauxAssistantMessage([fauxThinking('<unavailable-tool-call name="apply_patch"> inert thinking')]),
		]);

		await harness.session.prompt("think only");

		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(ttsrNudges(harness)).toEqual([]);
	});

	it("honors ttsr-rules-disabled for the manager-held builtin rule", async () => {
		harness = await createHarness({
			extensionFactories: [ttsrExtension],
			extensionFlagValues: new Map([["ttsr-rules-disabled", FABRICATED_TOOL_CALL_RULE_NAME]]),
			persistSession: true,
		});
		harness.setResponses([
			fauxAssistantMessage([fauxText('<unavailable-tool-call name="apply_patch"> inert imitation')]),
		]);

		await harness.session.prompt("edit the file");

		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(ttsrNudges(harness)).toEqual([]);
		expect(getMessageText(harness.session.messages.at(-1))).toContain("inert imitation");
	});
});

describe("collapse remediation persistence", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await createHarness({ extensionFactories: [ttsrExtension], persistSession: true });
	});

	afterEach(() => {
		harness.cleanup();
	});

	it("persists only the truncated same-role replacement and discards the garbage run durably", async () => {
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(`analyzing the problem ${"!".repeat(600)} and then back to normal`)]),
			fauxAssistantMessage([fauxText("recovered answer")]),
		]);

		await harness.session.prompt("do work");

		const lines = readSessionLines(harness);
		const entries = readSessionEntries(harness);
		expect(lines.length).toBe(entries.length);
		expect(lines.length).toBe(6);
		expectTtsrActivation(entries, {
			owner: "collapse-repetition",
			rules: ["collapse-repetition"],
			remediation: "nudge",
		});

		const assistantEntries = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
		expect(assistantEntries.length).toBe(2);

		const aborted = assistantEntries[0]?.message;
		expect(aborted?.role).toBe("assistant");
		expect(aborted?.stopReason).toBe("aborted");
		const thinking = streamText(aborted, "thinking");
		expect(thinking.startsWith("analyzing the problem")).toBe(true);
		expect(thinking.length).toBeLessThan(40);
		expect(streamText(aborted, "text")).toContain("[output interrupted by stream rule]");

		for (const line of lines) {
			expect(/!{301,}/.test(line)).toBe(false);
		}

		expect(getMessageText(assistantEntries[1]?.message)).toContain("recovered answer");
	});
});

describe("leakage remediation retry", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await createHarness({
			extensionFactories: [ttsrExtension],
			persistSession: true,
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
	});

	afterEach(() => {
		harness.cleanup();
	});

	it("persists the error shell, fires exactly one bounded auto-retry, and keeps the shell in history", async () => {
		const leaked = `${ctrlToken("sep")} ${ctrlToken("sep")} ${ctrlToken("sep")}`;
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(`Thinking... ${leaked} ${ctrlToken("sep")} trailing ${"x".repeat(400)}`)]),
			fauxAssistantMessage([fauxText("clean answer")]),
		]);

		await harness.session.prompt("do work");

		expect(harness.faux.getCallLog().length).toBe(2);

		const retryStarts = harness.eventsOfType("auto_retry_start");
		expect(retryStarts.length).toBe(1);
		expect(retryStarts[0]?.attempt).toBe(1);
		expect(retryStarts[0]?.maxAttempts).toBe(3);
		expect(retryStarts[0]?.errorMessage).toBe(LEAK_ERROR_MESSAGE);

		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);

		const lines = readSessionLines(harness);
		const entries = readSessionEntries(harness);
		expect(lines.length).toBe(5);
		expectTtsrActivation(entries, {
			owner: "control-token-leak",
			rules: ["control-token-leak"],
			remediation: "provider-error",
		});

		const assistantEntries = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
		expect(assistantEntries.length).toBe(2);
		const shelled = assistantEntries[0]?.message;
		expect(shelled?.role).toBe("assistant");
		expect(shelled?.stopReason).toBe("error");
		expect(shelled?.errorMessage).toBe(LEAK_ERROR_MESSAGE);
		expect(Array.isArray(shelled?.content) ? shelled.content : [1]).toHaveLength(0);
		expect(getMessageText(assistantEntries[1]?.message)).toContain("clean answer");
	});
});

describe("message_end fail-closed ordering", () => {
	let harness: Harness;
	let seenThinkingLengths: number[];
	let extensionErrors: string[];

	beforeEach(async () => {
		seenThinkingLengths = [];
		extensionErrors = [];
		const throwingExtension = (pi: Parameters<typeof ttsrExtension>[0]): void => {
			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;
				let thinkingLength = 0;
				for (const block of event.message.content) {
					if (block.type === "thinking") thinkingLength += block.thinking.length;
				}
				seenThinkingLengths.push(thinkingLength);
				throw new Error("downstream message_end handler boom");
			});
		};
		harness = await createHarness({
			extensionFactories: [ttsrExtension, throwingExtension],
			persistSession: true,
		});
		harness.getExtensionRunner().onError((error) => {
			if (error.event === "message_end") {
				extensionErrors.push(error.error);
			}
		});
	});

	afterEach(() => {
		harness.cleanup();
	});

	it("a throwing downstream handler sees the replacement, cannot undo it, and the throw is swallowed", async () => {
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(`analyzing the problem ${"!".repeat(600)} and then back to normal`)]),
			fauxAssistantMessage([fauxText("recovered answer")]),
		]);

		await harness.session.prompt("do work");

		expect(seenThinkingLengths.length).toBe(2);
		expect(seenThinkingLengths[0]).toBeGreaterThan(0);
		expect(seenThinkingLengths[0]).toBeLessThan(40);
		expect(extensionErrors).toEqual(["downstream message_end handler boom", "downstream message_end handler boom"]);

		const entries = readSessionEntries(harness);
		const assistantEntries = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
		expect(assistantEntries.length).toBe(2);
		const aborted = assistantEntries[0]?.message;
		expect(aborted?.role).toBe("assistant");
		expect(aborted?.stopReason).toBe("aborted");
		expect(streamText(aborted, "thinking").startsWith("analyzing the problem")).toBe(true);
		expect(streamText(aborted, "text")).toContain("[output interrupted by stream rule]");
		expect(harness.faux.getCallLog().length).toBe(2);
	});
});

describe("repetitive turns remediation", () => {
	let harness: Harness;

	afterEach(() => {
		harness.cleanup();
	});

	const STATUS_TURNS = [
		"I read this as continue supervising the portable matrix; it has started cleanly with 1 check green and 8 still pending.",
		"I read this as continue supervising the portable matrix; it has started cleanly with 2 checks green and 7 jobs pending.",
		"I read this as continue supervising the portable matrix; it has started cleanly with 3 checks green and 6 gates pending.",
		"I read this as continue supervising the portable matrix; it has started cleanly with 4 checks green and 5 builds pending.",
	];

	it("interrupts a cross-turn near-duplicate streak and injects a corrective nudge", async () => {
		harness = await createHarness({ extensionFactories: [ttsrExtension], persistSession: true });
		harness.setResponses([
			fauxAssistantMessage([fauxText(STATUS_TURNS[0])]),
			fauxAssistantMessage([fauxText(STATUS_TURNS[1])]),
			fauxAssistantMessage([fauxText(STATUS_TURNS[2])]),
			fauxAssistantMessage([fauxText(STATUS_TURNS[3])]),
			fauxAssistantMessage([fauxText("breaking the loop: taking a concrete action now")]),
		]);

		await harness.session.prompt("watch the gates");
		await harness.session.prompt("continue");
		await harness.session.prompt("continue");

		expect(harness.faux.getCallLog()).toHaveLength(5);
		const nudges = ttsrNudges(harness);
		expect(nudges.length).toBeGreaterThanOrEqual(1);
		for (const nudge of nudges) {
			expect(nudge).toContain('<system-interrupt reason="rule_violation" rule="repetitive-turns">');
			expect(nudge).toMatch(/stop|break|concrete action|do not restate/i);
		}
		expect(getMessageText(harness.session.messages.at(-1))).toContain("breaking the loop");

		const entries = readSessionEntries(harness);
		const activationEntries = entries.filter((e) => e.type === "custom" && e.customType === "rule-activation");
		expect(activationEntries.length).toBe(nudges.length);
	});

	it("detects repetition generically, not a baked-in phrase", async () => {
		harness = await createHarness({ extensionFactories: [ttsrExtension], persistSession: true });
		harness.setResponses([
			fauxAssistantMessage([
				fauxText("Still working on the frobnicate step. Pass 1 of 9 is done, queue drained here."),
			]),
			fauxAssistantMessage([
				fauxText("Still working on the frobnicate step. Pass 2 of 9 is done, queue drained again."),
			]),
			fauxAssistantMessage([
				fauxText("Still working on the frobnicate step. Pass 3 of 9 is done, queue drained fully."),
			]),
			fauxAssistantMessage([fauxText("frobnicate finished; moving to the deploy checklist")]),
		]);

		await harness.session.prompt("frob the widget");
		await harness.session.prompt("continue");

		expect(harness.faux.getCallLog()).toHaveLength(3);
		const nudges = ttsrNudges(harness);
		expect(nudges.length).toBeGreaterThanOrEqual(1);
		expect(nudges[0]).toContain('rule="repetitive-turns"');
	});

	it("leaves genuinely progressing turns alone", async () => {
		harness = await createHarness({ extensionFactories: [ttsrExtension], persistSession: true });
		harness.setResponses([
			fauxAssistantMessage([fauxText(STATUS_TURNS[0])]),
			fauxAssistantMessage([
				fauxText(
					"The two reds are again Linux jobs while Windows and macOS remain active; switching to a run-level watcher.",
				),
			]),
			fauxAssistantMessage([
				fauxText(
					"Windows now passes the integration binary; the store tests hardcode a shell path, so I am gating the live cases.",
				),
			]),
			fauxAssistantMessage([fauxText("All checks green; merging the pull request and removing the worktree.")]),
		]);

		await harness.session.prompt("watch the gates");
		await harness.session.prompt("continue");
		await harness.session.prompt("continue");
		await harness.session.prompt("continue");

		expect(harness.faux.getCallLog()).toHaveLength(4);
		expect(ttsrNudges(harness)).toEqual([]);
	});

	it("honors ttsr-rules-disabled for the repetitive-turns lane", async () => {
		harness = await createHarness({
			extensionFactories: [ttsrExtension],
			extensionFlagValues: new Map([["ttsr-rules-disabled", "repetitive-turns"]]),
			persistSession: true,
		});
		harness.setResponses(STATUS_TURNS.map((text) => fauxAssistantMessage([fauxText(text)])));

		await harness.session.prompt("watch the gates");
		await harness.session.prompt("continue");
		await harness.session.prompt("continue");
		await harness.session.prompt("continue");

		expect(harness.faux.getCallLog()).toHaveLength(4);
		expect(ttsrNudges(harness)).toEqual([]);
	});
});
