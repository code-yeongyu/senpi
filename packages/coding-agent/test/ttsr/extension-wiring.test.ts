import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import ttsrExtension from "../../src/core/extensions/builtin/ttsr/index.ts";
import { LEAK_ERROR_MESSAGE } from "../../src/core/extensions/builtin/ttsr/prompts.ts";
import { TTSR_INJECTION_CUSTOM_TYPE } from "../../src/core/extensions/builtin/ttsr/types.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";

const RULE_ACTIVATION_ENTRY_TYPE = "rule-activation";

interface PersistedMessage {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
	customType?: string;
}

interface PersistedEntry {
	type?: string;
	customType?: string;
	message?: PersistedMessage;
	data?: unknown;
}

function ctrlToken(name: string): string {
	return ["<", "|", name, "|", ">"].join("");
}

function readSessionEntries(harness: Harness): PersistedEntry[] {
	const file = harness.sessionManager.getSessionFile();
	expect(typeof file).toBe("string");
	return readFileSync(file as string, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as PersistedEntry);
}

function thinkingTextOf(message: PersistedMessage | undefined): string {
	if (message === undefined || !Array.isArray(message.content)) return "";
	return (message.content as Array<{ type: string; thinking?: string }>)
		.filter((block) => block.type === "thinking")
		.map((block) => block.thinking ?? "")
		.join("");
}

function createUi(notices: string[]): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message) => notices.push(message),
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>(): Promise<T> => {
			throw new Error("TTSR wiring tests do not render custom UI");
		},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

describe("ttsr extension wiring", () => {
	let harness: Harness;
	let notices: string[];

	beforeEach(async () => {
		notices = [];
		harness = await createHarness({ extensionFactories: [ttsrExtension], persistSession: true });
		await harness.session.bindExtensions({ mode: "tui", uiContext: createUi(notices) });
	});

	afterEach(() => {
		harness.cleanup();
	});

	it("aborts a collapsing thinking stream, durably truncates the garbage, nudges, and continues", async () => {
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(`analyzing the problem ${"!".repeat(600)}`)]),
			fauxAssistantMessage([fauxText("recovered answer")]),
		]);

		await harness.session.prompt("do work");

		const entries = readSessionEntries(harness);
		const assistantEntries = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
		const aborted = assistantEntries[0]?.message;
		expect(aborted?.stopReason).toBe("aborted");
		const thinking = thinkingTextOf(aborted);
		expect(thinking.startsWith("analyzing the problem")).toBe(true);
		expect(thinking.length).toBeLessThan(40);
		expect("!".repeat(100).length).toBeLessThan(600);
		expect(notices).toEqual([]);

		const injections = entries.filter((e) => e.type === "custom" && e.customType === TTSR_INJECTION_CUSTOM_TYPE);
		expect(injections).toHaveLength(0);

		const nudges = entries.filter((e) => e.type === "custom_message" && e.customType === TTSR_INJECTION_CUSTOM_TYPE);
		expect(nudges.length).toBeGreaterThan(0);

		const activations = entries.filter((e) => e.type === "custom" && e.customType === RULE_ACTIVATION_ENTRY_TYPE);
		expect(activations).toHaveLength(1);
		expect(activations).toContainEqual(
			expect.objectContaining({
				data: {
					kind: "ttsr",
					owner: "collapse-repetition",
					rules: ["collapse-repetition"],
					remediation: "nudge",
				},
			}),
		);

		expect(harness.faux.getCallLog().length).toBe(2);
		const finalText = assistantEntries.map((e) => getMessageText(e.message)).join("\n");
		expect(finalText).toContain("recovered answer");
	});

	it("replaces control-token leakage with an error shell and retries through the bounded machinery", async () => {
		const leaked = `${ctrlToken("sep")} ${ctrlToken("sep")} ${ctrlToken("sep")}`;
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(`Thinking... ${leaked} ${ctrlToken("sep")} trailing ${"x".repeat(400)}`)]),
			fauxAssistantMessage([fauxText("clean answer")]),
		]);

		await harness.session.prompt("do work");

		const entries = readSessionEntries(harness);
		const assistantEntries = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
		const shelled = assistantEntries[0]?.message;
		expect(shelled?.stopReason).toBe("error");
		expect(shelled?.errorMessage).toBe(LEAK_ERROR_MESSAGE);
		expect(Array.isArray(shelled?.content) ? shelled.content : [1]).toHaveLength(0);

		const injections = entries.filter((e) => e.type === "custom" && e.customType === TTSR_INJECTION_CUSTOM_TYPE);
		expect(injections).toHaveLength(0);

		const activations = entries.filter((e) => e.type === "custom" && e.customType === RULE_ACTIVATION_ENTRY_TYPE);
		expect(activations).toHaveLength(1);
		expect(activations).toContainEqual(
			expect.objectContaining({
				data: {
					kind: "ttsr",
					owner: "control-token-leak",
					rules: ["control-token-leak"],
					remediation: "provider-error",
				},
			}),
		);

		expect(harness.faux.getCallLog().length).toBe(2);
		const finalText = assistantEntries.map((e) => getMessageText(e.message)).join("\n");
		expect(finalText).toContain("clean answer");
	});
});
