import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxThinking } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { registerTtsrCommands, type TtsrPublicState } from "../../src/core/extensions/builtin/ttsr/commands.ts";
import ttsrExtension from "../../src/core/extensions/builtin/ttsr/index.ts";
import { TTSR_INJECTION_CUSTOM_TYPE, type TtsrRule } from "../../src/core/extensions/builtin/ttsr/types.ts";
import type { ExtensionAPI, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

interface PersistedMessage {
	role?: string;
	stopReason?: string;
	content?: unknown;
}

interface PersistedEntry {
	type?: string;
	customType?: string;
	message?: PersistedMessage;
}

interface Notification {
	message: string;
	type: string | undefined;
}

function _uiUnavailable(): never {
	throw new Error("ui surface not available in this test");
}

function createCapturingUi(notifications: Notification[]): ExtensionUIContext {
	return {
		notify: (message: string, type?: "info" | "warning" | "error") => {
			notifications.push({ message, type });
		},
	} as unknown as ExtensionUIContext;
}
function readSessionEntries(harness: Harness): PersistedEntry[] {
	const file = harness.sessionManager.getSessionFile();
	if (typeof file !== "string") throw new Error("expected a persisted session file");
	return readFileSync(file, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line): PersistedEntry => JSON.parse(line));
}

function assistantMessages(entries: PersistedEntry[]): PersistedMessage[] {
	const messages: PersistedMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "assistant") messages.push(entry.message);
	}
	return messages;
}

function thinkingOf(block: unknown): string {
	if (typeof block !== "object" || block === null) return "";
	if (!("type" in block) || block.type !== "thinking") return "";
	if (!("thinking" in block) || typeof block.thinking !== "string") return "";
	return block.thinking;
}

function thinkingTextOf(message: PersistedMessage | undefined): string {
	if (message === undefined || !Array.isArray(message.content)) return "";
	return message.content.map(thinkingOf).join("");
}

function sampleRules(): TtsrRule[] {
	return [
		{
			name: "fabricated-unavailable-tool-call",
			content: "Call real tools instead of printing transcript records.",
			condition: ["unavailable-tool-call"],
			scope: { allowText: true, allowThinking: false, toolScopes: [] },
			interruptMode: "always",
			source: "builtin",
		},
		{
			name: "no-secrets",
			content: "Never print credential material.",
			condition: ["api[_-]?key"],
			scope: { allowText: true, allowThinking: false, toolScopes: [] },
			interruptMode: "always",
			source: "project",
		},
		{
			name: "calm-edits",
			content: "Do not thrash edit calls.",
			condition: ["<<<<<<<"],
			scope: {
				allowText: false,
				allowThinking: false,
				toolScopes: [{ toolName: "edit", pathGlob: "**/*.ts" }],
			},
			interruptMode: "always",
			source: "global",
		},
	];
}

describe("/ttsr command", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	async function runTtsrCommand(state: TtsrPublicState): Promise<string> {
		const withCommands = (pi: ExtensionAPI): void => {
			ttsrExtension(pi);
			registerTtsrCommands(pi, () => state);
		};
		harness = await createHarness({ extensionFactories: [withCommands] });
		const runner = harness.getExtensionRunner();
		const command = runner.getCommand("ttsr");
		if (command === undefined) throw new Error("expected /ttsr command to be registered");
		const notifications: Notification[] = [];
		runner.setUIContext(createCapturingUi(notifications));
		await command.handler("", runner.createCommandContext());
		if (notifications.length !== 1) throw new Error(`expected exactly one notification, got ${notifications.length}`);
		const first = notifications[0];
		if (first === undefined) throw new Error("expected a notification");
		return first.message;
	}

	it("lists builtin detectors, user rules, injected rules, and enabled status", async () => {
		const output = await runTtsrCommand({
			rules: sampleRules(),
			injectedRuleNames: ["no-secrets"],
			disabled: false,
			disabledBy: null,
		});

		expect(output).toContain("STATUS");
		expect(output).toContain("enabled");
		expect(output).toContain("BUILTIN RULES");
		expect(output).toContain("collapse-repetition");
		expect(output).toContain("control-token-leak");
		expect(output).toContain("detector: collapse");
		expect(output).toContain("detector: control-leak");
		const builtinSection = output.slice(output.indexOf("BUILTIN RULES"), output.indexOf("USER RULES"));
		expect(builtinSection).toContain("fabricated-unavailable-tool-call [stream rule, scope: text]");
		expect(output).toContain("USER RULES");
		const userSection = output.slice(output.indexOf("USER RULES"), output.indexOf("INJECTED"));
		expect(userSection).not.toContain("fabricated-unavailable-tool-call");
		expect(output).toContain("no-secrets [project, scope: text]");
		expect(output).toContain("calm-edits [global, scope: tool:edit(**/*.ts)]");
		expect(output).toContain("INJECTED");
		expect(output).toContain("no-secrets");
	});

	it("reports disabled status and empty sections", async () => {
		const output = await runTtsrCommand({ rules: [], injectedRuleNames: [], disabled: true, disabledBy: "flag" });

		expect(output).toContain("disabled");
		expect(output).toContain("USER RULES\n(none)");
		expect(output).toContain("INJECTED\n(none)");
	});

	it.each([
		{ disabledBy: "flag", line: "disabled (ttsr-disabled flag set)" },
		{ disabledBy: "settings", line: "disabled (ttsr.enabled is false in settings)" },
	] as const)("names the $disabledBy as what turned TTSR off (senpi#4621)", async ({ disabledBy, line }) => {
		const output = await runTtsrCommand({ rules: [], injectedRuleNames: [], disabled: true, disabledBy });

		expect(output).toContain(`STATUS\n${line}\n`);
	});
});

describe("ttsr settings and flag gating", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("ttsr-disabled=true lets a collapsing stream complete untouched", async () => {
		harness = await createHarness({
			extensionFactories: [ttsrExtension],
			extensionFlagValues: new Map([["ttsr-disabled", true]]),
			persistSession: true,
		});
		const garbage = "!".repeat(600);
		harness.setResponses([fauxAssistantMessage([fauxThinking(`analyzing the problem ${garbage}`)])]);

		await harness.session.prompt("do work");

		const entries = readSessionEntries(harness);
		const finished = assistantMessages(entries)[0];
		expect(finished?.stopReason).toBe("stop");
		expect(thinkingTextOf(finished)).toContain(garbage);
		expect(entries.filter((e) => e.type === "custom" && e.customType === TTSR_INJECTION_CUSTOM_TYPE)).toHaveLength(0);
		expect(
			entries.filter((e) => e.type === "custom_message" && e.customType === TTSR_INJECTION_CUSTOM_TYPE),
		).toHaveLength(0);
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});

	it("ttsr-rules-disabled=collapse-repetition gates the builtin collapse detector off", async () => {
		harness = await createHarness({
			extensionFactories: [ttsrExtension],
			extensionFlagValues: new Map([["ttsr-rules-disabled", "collapse-repetition"]]),
			persistSession: true,
		});
		harness.setResponses([fauxAssistantMessage([fauxThinking(`analyzing the problem ${"!".repeat(600)}`)])]);

		await harness.session.prompt("do work");

		const entries = readSessionEntries(harness);
		const messages = assistantMessages(entries);
		const completed = messages[0];
		expect(completed?.stopReason).toBe("stop");
		const thinking = thinkingTextOf(completed);
		expect(thinking).toContain("!".repeat(200));
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});
});
