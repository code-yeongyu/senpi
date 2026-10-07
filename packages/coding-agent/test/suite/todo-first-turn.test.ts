import { rmSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	clearForcedToolChoiceRefusals,
	sendWithForcedToolChoiceFallback,
} from "@earendil-works/pi-ai/utils/tool-choice-fallback";
import { afterEach, describe, expect, it } from "vitest";
import {
	FIRST_TURN_CUSTOM_TYPE,
	type FirstTurnGateInput,
	namedToolChoicePayload,
	shouldArmFirstTurn,
	supportsNamedToolChoice,
} from "../../src/core/extensions/builtin/todotools/first-turn.ts";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";
import { fauxTodotoolsPi, model, TODO_PAYLOAD } from "./todo-first-turn-harness.ts";

const USER_ENTRY: SessionEntry = {
	type: "message",
	id: "u-1",
	parentId: null,
	timestamp: "2026-09-24T00:00:00.000Z",
	message: { role: "user", content: [{ type: "text", text: "earlier request" }], timestamp: 0 },
};

const ARMED: FirstTurnGateInput = {
	preview: false,
	trigger: "prompt",
	prompt: "add retries to fetchUser",
	branchEntries: [],
	todoActive: true,
	setting: "force",
	mode: "tui",
};

describe("shouldArmFirstTurn", () => {
	it.each<[string, Partial<FirstTurnGateInput>, boolean]>([
		["arms for a first work request in the TUI", {}, true],
		["arms for a child session over rpc", { mode: "rpc" }, true],
		["arms for the remind setting", { setting: "remind" }, true],
		["skips a question", { prompt: "why does fetchUser fail?" }, false],
		["skips an exclamation behind a closing quote and paren", { prompt: 'ship it!")  ' }, false],
		["skips a blank prompt", { prompt: "   " }, false],
		["skips a branch with a prior user message", { branchEntries: [USER_ENTRY] }, false],
		["skips an extension-triggered turn", { trigger: "extension" }, false],
		["skips an inactive todo tool", { todoActive: false }, false],
		["skips a preview", { preview: true }, false],
		["skips the off setting", { setting: "off" }, false],
		["skips print mode", { mode: "print" }, false],
		["skips json mode", { mode: "json" }, false],
	])("%s", (_label, override, expected) => {
		// given
		const input = { ...ARMED, ...override };

		// when
		const armed = shouldArmFirstTurn(input);

		// then
		expect(armed).toBe(expected);
	});
});

describe("named tool_choice wire shapes", () => {
	it.each<[Api, unknown]>([
		["anthropic-messages", { type: "tool", name: "todo" }],
		["openai-responses", { type: "function", name: "todo" }],
		["openai-completions", { type: "function", function: { name: "todo" } }],
		["google-generative-ai", undefined],
	])("%s", (api, expected) => {
		expect(namedToolChoicePayload(api, "todo")).toEqual(expected);
	});

	it.each<[string, Model<Api>, boolean]>([
		["claude-fable-5-1 through the resolved compat default", model("claude-fable-5-1"), false],
		["claude-opus-5 through the resolved compat default", model("claude-opus-5"), true],
		[
			"claude-opus-5 with forced tool choice disabled",
			model("claude-opus-5", "anthropic-messages", { supportsForcedToolChoice: false }),
			false,
		],
		["openai-responses", model("gpt-5.6", "openai-responses"), true],
		["openai-completions", model("grok-4.7", "openai-completions"), true],
		[
			"openai-completions with forced tool choice disabled",
			model("kiro-opus", "openai-completions", { supportsForcedToolChoice: false }),
			false,
		],
		[
			"openai-responses with forced tool choice disabled",
			model("kiro-opus", "openai-responses", { supportsForcedToolChoice: false }),
			false,
		],
		["google-generative-ai", model("gemini-3", "google-generative-ai"), false],
	])("supportsNamedToolChoice: %s", (_label, candidate, expected) => {
		expect(supportsNamedToolChoice(candidate)).toBe(expected);
	});
});

const tempDirs: string[] = [];
const harnesses: Harness[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("first-turn tool_choice through the faux pi shape", () => {
	it("forces the todo tool on the armed first request", async () => {
		// given
		const faux = fauxTodotoolsPi(tempDirs);
		const start = await faux.startTurn();

		// when
		const payload = await faux.providerRequest(TODO_PAYLOAD);

		// then
		expect(start.message?.customType).toBe(FIRST_TURN_CUSTOM_TYPE);
		expect(payload?.tool_choice).toEqual({ type: "tool", name: "todo" });
	});

	it("leaves tool_choice absent when the model rejects forced tool choice", async () => {
		// given
		const faux = fauxTodotoolsPi(tempDirs);
		await faux.startTurn();

		// when
		const payload = await faux.providerRequest(
			TODO_PAYLOAD,
			model("claude-opus-5", "anthropic-messages", { supportsForcedToolChoice: false }),
		);

		// then
		expect(payload?.tool_choice).toBeUndefined();
	});

	it("leaves the payload alone without a todo tool, with its own tool_choice, or with Anthropic thinking", async () => {
		// given
		const faux = fauxTodotoolsPi(tempDirs);
		await faux.startTurn();

		// when
		const results = [
			await faux.providerRequest({ tools: [{ name: "read" }] }),
			await faux.providerRequest({ ...TODO_PAYLOAD, tool_choice: { type: "auto" } }),
			await faux.providerRequest({ ...TODO_PAYLOAD, thinking: { type: "adaptive" } }),
		];

		// then
		expect(results).toEqual([undefined, undefined, undefined]);
	});

	it("does not force the second request after the first assistant message ends", async () => {
		// given
		const faux = fauxTodotoolsPi(tempDirs);
		await faux.startTurn();
		await faux.providerRequest(TODO_PAYLOAD);

		// when
		await faux.emit("message_end", { message: { role: "assistant", content: [] } });
		const second = await faux.providerRequest(TODO_PAYLOAD);

		// then
		expect(second?.tool_choice).toBeUndefined();
	});

	it("clears the pending force on agent_end without an assistant message", async () => {
		// given
		const faux = fauxTodotoolsPi(tempDirs);
		await faux.startTurn();

		// when
		await faux.emit("agent_end", { messages: [] });
		const payload = await faux.providerRequest(TODO_PAYLOAD);

		// then
		expect(payload?.tool_choice).toBeUndefined();
	});

	it("sends only the reminder to a model that refused a forced choice earlier in the process (senpi#2218)", async () => {
		// given: the adapter retried a Kiro refusal without tool_choice and the retry was accepted
		clearForcedToolChoiceRefusals();
		const kiro = model("kiro-opus", "openai-completions");
		const refusal = Object.assign(new Error("400 Kiro supports only automatic tool choice or tool_choice:none"), {
			status: 400,
		});
		const params: { tool_choice?: unknown } = { tool_choice: namedToolChoicePayload(kiro.api, "todo") };
		await sendWithForcedToolChoiceFallback({
			target: kiro,
			params,
			acceptsForcedToolChoice: true,
			isForced: (choice) => choice !== undefined,
			send: async (params) => {
				if (params.tool_choice !== undefined) throw refusal;
				return "ok";
			},
		});
		const faux = fauxTodotoolsPi(tempDirs);
		await faux.startTurn();

		// when
		const refused = await faux.providerRequest(TODO_PAYLOAD, kiro);
		const other = await faux.providerRequest(TODO_PAYLOAD, model("grok-4.7", "openai-completions"));
		const supported = supportsNamedToolChoice(kiro);
		clearForcedToolChoiceRefusals();

		// then
		expect(supported).toBe(false);
		expect(refused?.tool_choice).toBeUndefined();
		expect(other?.tool_choice).toEqual({ type: "function", function: { name: "todo" } });
	});

	it("sends only the reminder under the remind setting", async () => {
		// given
		const faux = fauxTodotoolsPi(tempDirs, { setting: "remind" });

		// when
		const start = await faux.startTurn();
		const payload = await faux.providerRequest(TODO_PAYLOAD);

		// then
		expect(start.message?.customType).toBe(FIRST_TURN_CUSTOM_TYPE);
		expect(payload?.tool_choice).toBeUndefined();
	});
});

async function createTuiHarness(): Promise<Harness> {
	const harness = await createHarness({ extensionFactories: [todotoolsExtension] });
	harnesses.push(harness);
	harness.getExtensionRunner().setUIContext(undefined, "tui");
	return harness;
}

function firstTurnEntries(harness: Harness): SessionEntry[] {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === FIRST_TURN_CUSTOM_TYPE);
}

describe("first-turn reminder through the real AgentSession", () => {
	it("persists the hidden reminder on the first prompt and not on the second", async () => {
		// given
		const harness = await createTuiHarness();
		harness.setResponses([fauxAssistantMessage("on it"), fauxAssistantMessage("still on it")]);

		// when
		await harness.session.prompt("add retries to fetchUser");
		await harness.session.prompt("also cover the timeout path");

		// then
		const entries = firstTurnEntries(harness);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.type === "custom_message" ? entries[0].display : undefined).toBe(false);
	}, 20_000);

	it("arms on the user's first request after an extension-triggered turn planned its own list (senpi#2137)", async () => {
		// given: an extension triggers a hidden turn before the user speaks, and that turn inits a list
		const harness = await createTuiHarness();
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("todo", { op: "init", list: [{ phase: "Onboarding", items: ["Greet the user"] }] })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("welcome"),
			fauxAssistantMessage("on it"),
		]);
		await harness.session.sendCustomMessage(
			{ customType: "test:bootstrap", content: "Greet the user.", display: false },
			{ triggerTurn: true },
		);
		expect(firstTurnEntries(harness)).toHaveLength(0);

		// when
		await harness.session.prompt("add retries to fetchUser");

		// then
		expect(firstTurnEntries(harness)).toHaveLength(1);
	}, 20_000);

	it("does not arm for a question", async () => {
		// given
		const harness = await createTuiHarness();
		harness.setResponses([fauxAssistantMessage("it retries twice")]);

		// when
		await harness.session.prompt("how does fetchUser retry?");

		// then
		expect(firstTurnEntries(harness)).toHaveLength(0);
	}, 20_000);
});
