/**
 * senpi#2424: a session-control delivery is a work request, not an extension bootstrap. The first
 * prompt or delivery must arm the first-turn todo opener exactly once, while hidden extension turns
 * and ask-user answer frames never arm.
 */

import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	FIRST_TURN_CUSTOM_TYPE,
	type FirstTurnGateInput,
	shouldArmFirstTurn,
} from "../../../src/core/extensions/builtin/todotools/first-turn.ts";
import todotoolsExtension from "../../../src/core/extensions/builtin/todotools/index.ts";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/session-control-types.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const ANSWER = "[Answer to question q-1]\nShip: yes";
const WORK = "add retries to fetchUser";
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function deliveryEntry(text = WORK): SessionEntry {
	return {
		type: "custom_message",
		id: "delivery-1",
		parentId: null,
		timestamp: "2026-10-01T00:00:00.000Z",
		customType: SESSION_CONTROL_DELIVERY_TYPE,
		content: text,
		display: true,
		details: { delivery_id: "d-1", source: "session_control", deliverAs: "followUp" },
	};
}

const DELIVERY_GATE: FirstTurnGateInput = {
	preview: false,
	trigger: "delivery",
	prompt: WORK,
	branchEntries: [],
	todoActive: true,
	setting: "force",
	mode: "tui",
};

describe("shouldArmFirstTurn with session-control deliveries (senpi#2424)", () => {
	it.each<[string, Partial<FirstTurnGateInput>, boolean]>([
		["arms for the first delivery", {}, true],
		["skips a delivery question", { prompt: "why does fetchUser fail?" }, false],
		["skips a delivery exclamation", { prompt: "ship it!" }, false],
		["skips a delivery in print mode", { mode: "print" }, false],
		["skips a delivery in json mode", { mode: "json" }, false],
		["skips a delivery after an earlier delivery", { branchEntries: [deliveryEntry()] }, false],
		["arms after an answer-frame delivery", { branchEntries: [deliveryEntry(ANSWER)] }, true],
	])("%s", (_label, override, expected) => {
		// Given
		const input = { ...DELIVERY_GATE, ...override };

		// When
		const armed = shouldArmFirstTurn(input);

		// Then
		expect(armed).toBe(expected);
	});
});

function firstTurnEntries(harness: Harness): SessionEntry[] {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === FIRST_TURN_CUSTOM_TYPE);
}

function triggerRecorder(triggers: string[]) {
	return (pi: ExtensionAPI): void => {
		pi.on("before_agent_start", async (event) => {
			triggers.push(event.trigger);
		});
	};
}

async function createDeliveryHarness(): Promise<{ harness: Harness; choices: unknown[]; triggers: string[] }> {
	const choices: unknown[] = [];
	const triggers: string[] = [];
	const harness = await createHarness({
		api: "openai-completions",
		extensionFactories: [todotoolsExtension, triggerRecorder(triggers)],
	});
	harnesses.push(harness);
	harness.getExtensionRunner().setUIContext(undefined, "tui");
	return { harness, choices, triggers };
}

function responseWithChoice(text: string, choices: unknown[]): FauxResponseStep {
	return async (_context, options, _state, model) => {
		const transformed = await options?.onPayload?.({ tools: [{ name: "todo" }] }, model);
		choices.push(
			typeof transformed === "object" && transformed !== null && "tool_choice" in transformed
				? transformed.tool_choice
				: undefined,
		);
		return fauxAssistantMessage(text);
	};
}

async function deliver(harness: Harness, deliveryId: string, text: string): Promise<void> {
	const settled = new Promise<void>((resolve, reject) => {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "agent_settled") return;
			unsubscribe();
			if (timeout !== undefined) clearTimeout(timeout);
			resolve();
		});
		timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error(`delivery ${deliveryId} did not settle`));
		}, 10_000);
	});
	expect(
		harness.session.externalAdmission.admit({
			delivery_id: deliveryId,
			text,
			deliverAs: "followUp",
		}).kind,
	).toBe("started");
	await settled;
}

describe("delivery opener through the real AgentSession (senpi#2424)", () => {
	it("arms the first gateway delivery with a forced todo choice, then never arms later deliveries", async () => {
		// Given
		const { harness, choices, triggers } = await createDeliveryHarness();
		harness.setResponses([responseWithChoice("first", choices), responseWithChoice("second", choices)]);

		// When
		await deliver(harness, "d-1", WORK);
		await deliver(harness, "d-2", "also cover the timeout path");

		// Then
		expect(firstTurnEntries(harness)).toHaveLength(1);
		expect(choices).toEqual([{ type: "function", function: { name: "todo" } }, undefined]);
		expect(triggers).toEqual(["delivery", "delivery"]);
	});

	it("arms only the delivery when a delivery precedes a prompt", async () => {
		// Given
		const { harness, choices, triggers } = await createDeliveryHarness();
		harness.setResponses([responseWithChoice("delivery", choices), responseWithChoice("prompt", choices)]);

		// When
		await deliver(harness, "d-first", WORK);

		// Then
		expect(firstTurnEntries(harness)).toHaveLength(1);

		// When
		await harness.session.prompt("also cover the timeout path");

		// Then
		expect(firstTurnEntries(harness)).toHaveLength(1);
		expect(choices).toEqual([{ type: "function", function: { name: "todo" } }, undefined]);
		expect(triggers).toEqual(["delivery", "prompt"]);
	});

	it("arms only the prompt when a prompt precedes a delivery", async () => {
		// Given
		const { harness, choices, triggers } = await createDeliveryHarness();
		harness.setResponses([responseWithChoice("prompt", choices), responseWithChoice("delivery", choices)]);

		// When
		await harness.session.prompt(WORK);

		// Then
		expect(firstTurnEntries(harness)).toHaveLength(1);

		// When
		await deliver(harness, "d-second", "also cover the timeout path");

		// Then
		expect(firstTurnEntries(harness)).toHaveLength(1);
		expect(choices).toEqual([{ type: "function", function: { name: "todo" } }, undefined]);
		expect(triggers).toEqual(["prompt", "delivery"]);
	});

	it("does not arm an extension hidden turn that only copies the delivery custom type", async () => {
		// Given
		const { harness, choices, triggers } = await createDeliveryHarness();
		harness.setResponses([responseWithChoice("bootstrap", choices), responseWithChoice("delivery", choices)]);

		// When
		await harness.session.sendCustomMessage(
			{
				customType: SESSION_CONTROL_DELIVERY_TYPE,
				content: "Greet the user.",
				display: false,
				details: { delivery_id: "spoofed", source: "session_control", deliverAs: "nextTurn" },
			},
			{ triggerTurn: true },
		);

		// Then
		expect(firstTurnEntries(harness)).toHaveLength(0);

		// When
		await deliver(harness, "d-after-bootstrap", WORK);

		// Then
		expect(firstTurnEntries(harness)).toHaveLength(1);
		expect(choices).toEqual([undefined, { type: "function", function: { name: "todo" } }]);
		expect(triggers).toEqual(["extension", "delivery"]);
	});

	it("does not arm a delivered answer frame, then arms the first delivered work request", async () => {
		// Given
		const { harness, choices, triggers } = await createDeliveryHarness();
		harness.setResponses([responseWithChoice("answer", choices), responseWithChoice("work", choices)]);

		// When
		await deliver(harness, "d-answer", ANSWER);

		// Then
		expect(firstTurnEntries(harness)).toHaveLength(0);

		// When
		await deliver(harness, "d-work", WORK);

		// Then
		expect(firstTurnEntries(harness)).toHaveLength(1);
		expect(choices).toEqual([undefined, { type: "function", function: { name: "todo" } }]);
		expect(triggers).toEqual(["delivery", "delivery"]);
	});

	it("does not arm a typed answer frame, then arms the first delivered work request", async () => {
		// Given
		const { harness, choices, triggers } = await createDeliveryHarness();
		harness.setResponses([responseWithChoice("answer", choices), responseWithChoice("work", choices)]);

		// When
		await harness.session.prompt(ANSWER);

		// Then
		expect(firstTurnEntries(harness)).toHaveLength(0);

		// When
		await deliver(harness, "d-after-answer", WORK);

		// Then
		expect(firstTurnEntries(harness)).toHaveLength(1);
		expect(choices).toEqual([undefined, { type: "function", function: { name: "todo" } }]);
		expect(triggers).toEqual(["prompt", "delivery"]);
	});
});
