import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import {
	parseRuleActivationDetails,
	RULE_ACTIVATION_ENTRY_TYPE,
} from "../../src/core/extensions/builtin/rule-activation/types.ts";
import ttsrExtension from "../../src/core/extensions/builtin/ttsr/index.ts";
import { TtsrManager, type TtsrMatchContext } from "../../src/core/extensions/builtin/ttsr/manager.ts";
import { COLLAPSE_RULE_NAME } from "../../src/core/extensions/builtin/ttsr/prompts.ts";
import {
	DEFAULT_TTSR_SETTINGS,
	TTSR_INJECTION_CUSTOM_TYPE,
	type TtsrRule,
	type TtsrScope,
} from "../../src/core/extensions/builtin/ttsr/types.ts";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";

const ALL_SCOPE: TtsrScope = { allowText: true, allowThinking: true, toolScopes: [] };

interface PersistedEntry {
	type?: string;
	customType?: string;
	message?: { role?: string; stopReason?: string };
}

function compileCondition(pattern: string): RegExp | null {
	try {
		return new RegExp(pattern);
	} catch {
		return null;
	}
}

function makeRule(name: string): TtsrRule {
	return {
		name,
		content: `content of ${name}`,
		condition: ["needle"],
		scope: ALL_SCOPE,
		interruptMode: "always",
		source: "project",
	};
}

function ctx(): TtsrMatchContext {
	return { source: "text", streamKey: "main" };
}

function ruleNames(rules: readonly TtsrRule[]): string[] {
	return rules.map((rule) => rule.name);
}

function sessionFileOf(harness: Harness): string {
	const file = harness.sessionManager.getSessionFile();
	if (file === undefined) throw new Error("expected a persisted session file");
	return file;
}

function readPersistedEntries(file: string): PersistedEntry[] {
	return readFileSync(file, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line): PersistedEntry => JSON.parse(line));
}

function injectedNamesFrom(entries: readonly SessionEntry[]): string[] {
	const names: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === RULE_ACTIVATION_ENTRY_TYPE) {
			const details = parseRuleActivationDetails(entry.data);
			if (details?.kind === "ttsr") names.push(...details.rules);
			continue;
		}
		if (entry.customType !== TTSR_INJECTION_CUSTOM_TYPE) continue;
		const data: unknown = entry.data;
		if (typeof data !== "object" || data === null || !("rules" in data)) continue;
		const rules = data.rules;
		if (!Array.isArray(rules)) continue;
		for (const rule of rules) {
			if (typeof rule === "string") names.push(rule);
		}
	}
	return names;
}

function nudgeTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "custom")
		.filter((message) => message.customType === TTSR_INJECTION_CUSTOM_TYPE)
		.map((message) => (typeof message.content === "string" ? message.content : ""));
}

function makeManager(): TtsrManager {
	return new TtsrManager(DEFAULT_TTSR_SETTINGS, compileCondition);
}

describe("ttsr persistence", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createTtsrHarness(): Promise<Harness> {
		const harness = await createHarness({ extensionFactories: [ttsrExtension], persistSession: true });
		harnesses.push(harness);
		return harness;
	}

	async function runCollapse(harness: Harness): Promise<void> {
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(`analyzing the problem ${"!".repeat(600)}`)]),
			fauxAssistantMessage([fauxText("recovered answer")]),
		]);
		await harness.session.prompt("do work");
	}

	it("restores injected rule names from a reopened session file and keeps once-rules suppressed", async () => {
		const harness = await createTtsrHarness();
		await runCollapse(harness);

		const file = sessionFileOf(harness);
		const persisted = readPersistedEntries(file);
		const persistedRecords = persisted.filter(
			(entry) => entry.type === "custom" && entry.customType === RULE_ACTIVATION_ENTRY_TYPE,
		);
		expect(persistedRecords.length).toBeGreaterThan(0);

		const reopened = SessionManager.open(file);
		const reopenedRecords = reopened
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === RULE_ACTIVATION_ENTRY_TYPE);
		expect(reopenedRecords.length).toBe(persistedRecords.length);
		const names = injectedNamesFrom(reopened.getEntries());
		expect(names).toContain(COLLAPSE_RULE_NAME);

		const restored = makeManager();
		restored.addRule(makeRule(COLLAPSE_RULE_NAME));
		restored.addRule(makeRule("fresh-rule"));
		restored.restoreInjected(names);
		expect(restored.getInjectedRuleNames()).toContain(COLLAPSE_RULE_NAME);
		expect(ruleNames(restored.checkDelta("needle", ctx()))).toEqual(["fresh-rule"]);

		const plain = makeManager();
		plain.addRule(makeRule(COLLAPSE_RULE_NAME));
		plain.addRule(makeRule("fresh-rule"));
		expect(ruleNames(plain.checkDelta("needle", ctx()))).toEqual([COLLAPSE_RULE_NAME, "fresh-rule"]);
	});

	it("keeps the nudge custom message and injection records through compaction", async () => {
		const harness = await createTtsrHarness();
		await runCollapse(harness);

		expect(nudgeTexts(harness).some((text) => text.includes(COLLAPSE_RULE_NAME))).toBe(true);

		const firstAssistantEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (firstAssistantEntry === undefined) throw new Error("expected an assistant entry");

		const result = await harness.session.applyCompaction(
			{ summary: "compacted for test", firstKeptEntryId: firstAssistantEntry.id, tokensBefore: 42 },
			{ reason: "extension", expectedRevision: harness.session.getMessageRevision() },
		);
		expect(result).toEqual({ applied: true, reason: "ok" });
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");

		const survivingNudges = nudgeTexts(harness);
		expect(survivingNudges.some((text) => text.includes(COLLAPSE_RULE_NAME))).toBe(true);

		const persisted = readPersistedEntries(sessionFileOf(harness));
		expect(
			persisted.filter((entry) => entry.type === "custom" && entry.customType === RULE_ACTIVATION_ENTRY_TYPE).length,
		).toBeGreaterThan(0);
		expect(
			persisted.filter((entry) => entry.type === "custom_message" && entry.customType === TTSR_INJECTION_CUSTOM_TYPE)
				.length,
		).toBeGreaterThan(0);
		expect(persisted.filter((entry) => entry.type === "compaction")).toHaveLength(1);

		harness.setResponses([fauxAssistantMessage([fauxText("after compaction")])]);
		await harness.session.prompt("continue");
		expect(getMessageText(harness.session.messages.at(-1))).toContain("after compaction");
	});

	it("tolerates malformed injection entries and still aborts a collapsing stream", async () => {
		const harness = await createTtsrHarness();
		harness.sessionManager.appendCustomEntry(TTSR_INJECTION_CUSTOM_TYPE, "not an object");
		harness.sessionManager.appendCustomEntry(TTSR_INJECTION_CUSTOM_TYPE, { rules: "not-an-array" });
		harness.sessionManager.appendCustomEntry(TTSR_INJECTION_CUSTOM_TYPE, { rules: [42, null, "ghost-rule"] });

		await runCollapse(harness);

		const persisted = readPersistedEntries(sessionFileOf(harness));
		const assistantEntries = persisted.filter(
			(entry) => entry.type === "message" && entry.message?.role === "assistant",
		);
		expect(assistantEntries[0]?.message?.stopReason).toBe("aborted");
		expect(harness.faux.getCallLog().length).toBe(2);
		expect(assistantEntries.map((entry) => getMessageText(entry.message)).join("\n")).toContain("recovered answer");

		const reopened = SessionManager.open(sessionFileOf(harness));
		const names = injectedNamesFrom(reopened.getEntries());
		expect(names).toHaveLength(2);
		expect(names).toContain("ghost-rule");
		expect(names).toContain(COLLAPSE_RULE_NAME);
	});
});
