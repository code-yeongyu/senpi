import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import ttsrExtension from "../../../src/core/extensions/builtin/ttsr/index.ts";
import { ruleAlreadyCorrected } from "../../../src/core/extensions/builtin/ttsr/follow-up-limit.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#4537: two progress summaries in the same mandated status format, describing different work.
const SUMMARY_A =
	"Implemented the parser cache loader toward release readiness. You need: 2,026 new cases plus 802 regressions pass in strict and debug modes; two release builds pass and 82 guards match. Evidence saved. Schema and runtime gates remain open; milestone M1 stays PARTIAL, 195/222. No owned resources remain active. Now: Wire cache state into the runtime. Next: Finish the remaining acceptance requirements.";
const SUMMARY_B =
	"Implemented the string table move semantics toward release readiness. You need: 259 new cases plus 2,828 regressions pass in strict and debug modes; two release builds pass and 86 guards match. Captured and audited 841 dependency words. Construction and runtime gates remain open; milestone M1 stays PARTIAL, 195/222. No owned resources remain active. Now: Wire cache state into the runtime. Next: Finish the remaining acceptance requirements.";
const STATUS = "Still working on the frobnicate step. Pass 1 of 9 is done, queue drained here.";

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo text back",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_toolCallId, params) => {
		const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
		return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
	},
};

interface AssistantView {
	readonly stopReason: unknown;
	readonly text: string;
}

function assistantViews(harness: Harness): AssistantView[] {
	return harness.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") return [];
		const text = entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		return [{ stopReason: entry.message.stopReason, text }];
	});
}

function customEntries(harness: Harness, customType: string): SessionEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === customType);
}

/** Resolves at the session's final idle, after any automatic follow-up turns, bounded by a timeout. */
function nextIdle(harness: Harness): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("agent_idle was not emitted"));
		}, 10_000);
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "agent_idle") return;
			clearTimeout(timer);
			unsubscribe();
			resolve();
		});
	});
}

function corrections(harness: Harness): SessionEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === "ttsr-injection");
}

describe("senpi#4537 repetitive-turns in a long working session", () => {
	let harness: Harness;

	afterEach(() => {
		harness.cleanup();
	});

	it("leaves similar progress summaries alone when the agent did tool work between them", async () => {
		// given a summary, then a run that calls a tool and reports in the same status format
		harness = await createHarness({ extensionFactories: [ttsrExtension], tools: [echoTool] });
		harness.setResponses([
			fauxAssistantMessage([fauxText(SUMMARY_A)]),
			fauxAssistantMessage([fauxToolCall("echo", { text: "edit" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText(SUMMARY_B)]),
		]);

		// when
		await harness.session.prompt("work");
		await harness.session.prompt("continue");

		// then the second summary is kept whole, with no correction, activation or pause
		expect(assistantViews(harness)).toEqual([
			{ stopReason: "stop", text: SUMMARY_A },
			{ stopReason: "toolUse", text: "" },
			{ stopReason: "stop", text: SUMMARY_B },
		]);
		expect(corrections(harness)).toEqual([]);
		expect(customEntries(harness, "rule-activation")).toEqual([]);
		expect(customEntries(harness, "engine-paused")).toEqual([]);
	});

	it("still corrects a text-only repeat, after the reply has completed instead of cutting it off", async () => {
		// given a model that repeats the same status with no work in between
		harness = await createHarness({ extensionFactories: [ttsrExtension], tools: [echoTool] });
		harness.setResponses([
			fauxAssistantMessage([fauxText(STATUS)]),
			fauxAssistantMessage([fauxText(STATUS)]),
			fauxAssistantMessage([fauxToolCall("echo", { text: "act" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Took a concrete action; the frobnicate step is finished.")]),
		]);

		// when
		await harness.session.prompt("frob the widget");
		await harness.session.prompt("continue");

		// then one correction follows the complete repeated reply
		expect(corrections(harness)).toHaveLength(1);
		expect(assistantViews(harness)[1]).toEqual({ stopReason: "stop", text: STATUS });
		expect(customEntries(harness, "ttsr-loop-stopped")).toEqual([]);
	});

	it("stops a repeat right after the correction", async () => {
		// given a model that keeps repeating even after the correction
		harness = await createHarness({ extensionFactories: [ttsrExtension], tools: [echoTool] });
		harness.setResponses([
			fauxAssistantMessage([fauxText(STATUS)]),
			fauxAssistantMessage([fauxText(STATUS)]),
			fauxAssistantMessage([fauxText(STATUS)]),
			fauxAssistantMessage([fauxText("unexpected extra turn")]),
		]);

		// when
		await harness.session.prompt("frob the widget");
		await harness.session.prompt("continue");

		// then the loop ends after one correction
		expect(harness.faux.getCallLog()).toHaveLength(3);
		expect(corrections(harness)).toHaveLength(1);
		expect(customEntries(harness, "ttsr-loop-stopped")).toHaveLength(1);
	});

	it("writes no 'nudge queued' activation for a correction it suppresses", async () => {
		// given a correction, a different reply, then another owner's automatic turn that repeats that reply,
		// all with no user message and no tool call, so the rule fires again inside the same episode
		const other = "Checked the queue again; the frobnicate step is still running on the second worker.";
		let afterCorrection = false;
		let sentOtherWork = false;
		harness = await createHarness({
			extensionFactories: [
				ttsrExtension,
				(pi) => {
					pi.on("message_start", (event) => {
						if (event.message.role === "custom" && event.message.customType === "ttsr-injection") {
							afterCorrection = true;
						}
					});
					pi.on("agent_settled", () => {
						if (!afterCorrection || sentOtherWork) return;
						sentOtherWork = true;
						pi.sendMessage(
							{ customType: "other-work", content: "do more", display: false },
							{ triggerTurn: true },
						);
					});
				},
			],
			tools: [echoTool],
			persistSession: true,
		});
		await harness.session.bindExtensions({ mode: "rpc" });
		harness.setResponses([
			fauxAssistantMessage([fauxText(STATUS)]),
			fauxAssistantMessage([fauxText(STATUS)]),
			fauxAssistantMessage([fauxText(other)]),
			fauxAssistantMessage([fauxText(other)]),
			fauxAssistantMessage([fauxText("unexpected extra turn")]),
		]);

		// when
		await harness.session.prompt("frob the widget");
		const idle = nextIdle(harness);
		await harness.session.prompt("continue");
		await idle;

		// then the second hit is stopped, and only the correction actually sent has an activation notice
		expect(harness.faux.getCallLog()).toHaveLength(4);
		expect(corrections(harness)).toHaveLength(1);
		expect(customEntries(harness, "ttsr-loop-stopped")).toHaveLength(1);
		expect(customEntries(harness, "rule-activation")).toHaveLength(1);
	});
});

describe("senpi#4537 the one-correction bound is scoped to one repetition episode", () => {
	const injection = {
		type: "custom_message",
		customType: "ttsr-injection",
		details: { rules: ["repetitive-turns"] },
	} as unknown as SessionEntry;
	const user = { type: "message", message: { role: "user", content: "go" } } as unknown as SessionEntry;
	const acted = {
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "echo", arguments: {} }] },
	} as unknown as SessionEntry;
	const toolResult = {
		type: "message",
		message: { role: "toolResult", toolName: "echo", content: [{ type: "text", text: "ok" }] },
	} as unknown as SessionEntry;
	const statusOnly = {
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: STATUS }] },
	} as unknown as SessionEntry;

	it.each([
		{ name: "a repeat right after the correction", entries: [user, injection, statusOnly], spent: true },
		{
			name: "a new episode after the agent acted again",
			entries: [user, injection, acted, toolResult, statusOnly],
			spent: false,
		},
		{ name: "a new user message", entries: [injection, user, statusOnly], spent: false },
		{
			name: "tool work before the correction",
			entries: [user, acted, toolResult, injection, statusOnly],
			spent: true,
		},
	])("treats the correction as spent only for $name -> $spent", ({ entries, spent }) => {
		expect(ruleAlreadyCorrected(entries, "repetitive-turns")).toBe(spent);
	});
});
