import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import ttsrExtension from "../../../src/core/extensions/builtin/ttsr/index.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

// senpi#4621 (reported in oh-my-openagent#11610): DeepSeek V4.1 Flash at thinking `max` writes DSML tool-call
// envelopes into its reasoning and imitates them until the reply collapses. Synthetic text in the reported shape.
const BAR = "\uFF5C";
const open = (rest: string): string => `<${BAR}DSML${BAR}${rest}>`;
const close = (rest: string): string => `</${BAR}DSML${BAR}${rest}>`;
const DSML_IMITATION_LOOP = Array.from(
	{ length: 12 },
	(_, index) =>
		`${open(' invoke name="bash"')}\n${open(' parameter name="command" string="true"')}echo done${27 + index}${close(" parameter")}\n${close(" invoke")}\n`,
).join("");
const DSML_THINKING = `Let me check the build output first.\n${DSML_IMITATION_LOOP}`;
const COLLAPSED_THINKING = `analyzing the problem ${"!".repeat(600)} and then back to normal`;

function customEntries(harness: Harness, customType: string): SessionEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === customType);
}

function corrections(harness: Harness): SessionEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === "ttsr-injection");
}

function activationOwners(harness: Harness): unknown[] {
	return customEntries(harness, "rule-activation").map((entry) =>
		entry.type === "custom" && typeof entry.data === "object" && entry.data !== null && "owner" in entry.data
			? entry.data.owner
			: undefined,
	);
}

function lastAssistantText(harness: Harness): string {
	const assistants = harness.session.messages.filter((message) => message.role === "assistant");
	return getMessageText(assistants.at(-1));
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

describe("senpi#4621 DSML in thinking and the one-correction stop", () => {
	let harness: Harness;

	afterEach(() => {
		harness.cleanup();
	});

	it("routes a DSML envelope in thinking to a resample, never to a collapse-repetition correction", async () => {
		// given a model whose reasoning imitates DSML tool calls in a loop, then answers cleanly on the resample
		harness = await createHarness({
			extensionFactories: [ttsrExtension],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(DSML_THINKING)]),
			fauxAssistantMessage([fauxText("clean answer")]),
		]);

		// when
		const idle = nextIdle(harness);
		await harness.session.prompt("check the build");
		await idle;

		// then the leak guard resampled it: no corrective nudge and no stop
		expect(activationOwners(harness)).toEqual(["control-token-leak"]);
		expect(corrections(harness)).toEqual([]);
		expect(customEntries(harness, "ttsr-loop-stopped")).toEqual([]);
		expect(lastAssistantText(harness)).toContain("clean answer");
	});

	it("gives the next person turn a fresh correction after a stop, so a '.' continue is not stopped at once", async () => {
		// given a reply that collapsed, was corrected, collapsed again and was stopped
		harness = await createHarness({ extensionFactories: [ttsrExtension] });
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(COLLAPSED_THINKING)]),
			fauxAssistantMessage([fauxThinking(COLLAPSED_THINKING)]),
		]);
		const stopped = nextIdle(harness);
		await harness.session.prompt("do work");
		await stopped;
		expect(corrections(harness)).toHaveLength(1);
		expect(customEntries(harness, "ttsr-loop-stopped")).toHaveLength(1);

		// when the person continues with "." and the first reply collapses once more
		harness.appendResponses([
			fauxAssistantMessage([fauxThinking(COLLAPSED_THINKING)]),
			fauxAssistantMessage([fauxText("recovered answer")]),
		]);
		const resumed = nextIdle(harness);
		await harness.session.prompt(".");
		await resumed;

		// then that turn gets its own correction and recovers, and the earlier stop is reported once, typed
		expect(corrections(harness)).toHaveLength(2);
		expect(lastAssistantText(harness)).toContain("recovered answer");
		expect(harness.getPendingResponseCount()).toBe(0);
		const stops = customEntries(harness, "ttsr-loop-stopped");
		expect(stops).toHaveLength(1);
		expect(stops[0]?.type === "custom" ? stops[0].data : undefined).toMatchObject({
			rules: ["collapse-repetition"],
			reason: "repeated-after-correction",
		});
	});
});

const STATUS = "Still working on the frobnicate step. Pass 1 of 9 is done, queue drained here.";

describe("senpi#4621 TTSR off turns every rule off, repetitive-turns included", () => {
	let harness: Harness;

	afterEach(() => {
		harness.cleanup();
	});

	it.each([
		{ name: "ttsr.enabled false in settings.json", settingsContent: JSON.stringify({ ttsr: { enabled: false } }) },
		{ name: "the --ttsr-disabled flag", flags: new Map<string, boolean | string>([["ttsr-disabled", true]]) },
	])("$name leaves a repeated text-only reply alone", async ({ settingsContent, flags }) => {
		// given a model that repeats the same status with no work in between
		harness = await createHarness({
			extensionFactories: [ttsrExtension],
			fileSettings: true,
			settingsContent: settingsContent ?? "{}",
			...(flags === undefined ? {} : { extensionFlagValues: flags }),
		});
		harness.setResponses([fauxAssistantMessage([fauxText(STATUS)]), fauxAssistantMessage([fauxText(STATUS)])]);

		// when
		await harness.session.prompt("frob the widget");
		await harness.session.prompt("continue");

		// then no rule fires: no activation, correction, stop or pause
		expect(activationOwners(harness)).toEqual([]);
		expect(corrections(harness)).toEqual([]);
		expect(customEntries(harness, "ttsr-loop-stopped")).toEqual([]);
		expect(customEntries(harness, "engine-paused")).toEqual([]);
	});
});

describe("senpi#4621 TTSR settings for hosts that launch with fixed arguments", () => {
	let harness: Harness;

	afterEach(() => {
		harness.cleanup();
	});

	it.each([
		{ name: "ttsr.enabled false", settings: { ttsr: { enabled: false } } },
		{ name: "ttsr.disabledRules", settings: { ttsr: { disabledRules: ["collapse-repetition"] } } },
	])("$name in settings.json turns the collapse rule off", async ({ settings }) => {
		// given a settings.json in the agent directory (what a desktop-spawned session reads) and no CLI flag
		harness = await createHarness({
			extensionFactories: [ttsrExtension],
			fileSettings: true,
			settingsContent: JSON.stringify(settings),
		});
		harness.setResponses([fauxAssistantMessage([fauxThinking(COLLAPSED_THINKING), fauxText("done")])]);

		// when
		await harness.session.prompt("do work");

		// then the reply is kept whole, with no activation, correction or stop
		const assistant = harness.session.messages.find((message) => message.role === "assistant");
		expect(assistant?.role === "assistant" ? assistant.stopReason : undefined).toBe("stop");
		expect(activationOwners(harness)).toEqual([]);
		expect(corrections(harness)).toEqual([]);
		expect(lastAssistantText(harness)).toContain("done");
	});
});
