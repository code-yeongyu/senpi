import { chmodSync } from "node:fs";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { ENGINE_TURN_LIMIT_ENTRY_TYPE } from "../../../src/core/engine-turn-limit.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const AUTO_TURN_ATTEMPTS = 20;

function selfContinuing(customType: string, attempts: number, registerWork = false) {
	return (pi: ExtensionAPI): void => {
		let sent = 0;
		if (registerWork) {
			pi.registerTool({
				name: "do_work",
				label: "Do work",
				description: "One unit of real work",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
			});
		}
		pi.on("agent_settled", () => {
			if (sent >= attempts) return;
			sent += 1;
			pi.sendMessage({ customType, content: "continue", display: false }, { triggerTurn: true });
		});
	};
}

function armedByInput(customType: string, armText: string, attempts: number, onArmedTurnStart: () => void) {
	return (pi: ExtensionAPI): void => {
		let armed = false;
		let sent = 0;
		let started = false;
		pi.on("input", (event) => {
			if (event.text === armText) armed = true;
		});
		pi.on("turn_start", () => {
			if (!armed || started) return;
			started = true;
			onArmedTurnStart();
		});
		pi.on("agent_settled", () => {
			if (!armed || sent >= attempts) return;
			sent += 1;
			pi.sendMessage({ customType, content: "continue", display: false }, { triggerTurn: true });
		});
	};
}

function engineTurns(harness: Harness, customType: string): number {
	return harness.session.messages.filter((message) => message.role === "custom" && message.customType === customType)
		.length;
}

function limitEntries(harness: Harness): unknown[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === ENGINE_TURN_LIMIT_ENTRY_TYPE);
}

async function drain(harness: Harness): Promise<void> {
	for (let pass = 0; pass < AUTO_TURN_ATTEMPTS * 6; pass++) {
		await harness.session.waitForIdle();
		await Promise.resolve();
	}
}

describe("senpi#2967 engine-originated turns are bounded for every source", () => {
	let harness: Harness;

	afterEach(() => {
		harness.cleanup();
	});

	it.each(["ttsr-injection", "goal-continuation"])(
		"stops a %s source that keeps starting tool-free turns after 12 in a minute",
		async (customType) => {
			// given a source that starts a new turn after every reply, and a model that never calls a tool
			harness = await createHarness({ extensionFactories: [selfContinuing(customType, AUTO_TURN_ATTEMPTS)] });
			harness.setResponses(
				Array.from({ length: AUTO_TURN_ATTEMPTS + 2 }, (_, index) =>
					fauxAssistantMessage([fauxText(`status update ${index}`)]),
				),
			);

			// when one user message arrives
			await harness.session.prompt("start");
			await drain(harness);

			// then the engine started no more than 12 turns on its own, said why it stopped, and kept the refused message
			expect(harness.faux.getCallLog().length).toBe(1 + 12);
			expect(limitEntries(harness)).toHaveLength(1);
			expect(engineTurns(harness, customType)).toBe(13);
			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "engine-turn-start"),
			).toHaveLength(12);
		},
	);

	it("lets a goal run that does real work in every turn continue past the per-minute breaker", async () => {
		// given a goal-like source whose every turn calls a tool before answering
		harness = await createHarness({
			extensionFactories: [selfContinuing("goal-continuation", AUTO_TURN_ATTEMPTS, true)],
		});
		harness.setResponses(
			Array.from({ length: AUTO_TURN_ATTEMPTS + 1 }, (_, index) => [
				fauxAssistantMessage([fauxToolCall("do_work", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText(`progress ${index}`)]),
			]).flat(),
		);

		// when one user message starts it
		await harness.session.prompt("start");
		await drain(harness);

		// then every continuation ran and the limit never tripped
		expect(engineTurns(harness, "goal-continuation")).toBe(AUTO_TURN_ATTEMPTS);
		expect(limitEntries(harness)).toEqual([]);
	});

	it("lets the next user message lift a pause at once", async () => {
		// given a source that already hit the per-minute breaker and keeps continuing after every reply
		harness = await createHarness({ extensionFactories: [selfContinuing("goal-continuation", AUTO_TURN_ATTEMPTS)] });
		harness.setResponses(
			Array.from({ length: AUTO_TURN_ATTEMPTS + 6 }, (_, index) =>
				fauxAssistantMessage([fauxText(`status ${index}`)]),
			),
		);
		await harness.session.prompt("start");
		await drain(harness);
		expect(limitEntries(harness)).toHaveLength(1);
		const callsAtStop = harness.faux.getCallLog().length;

		// when the user sends any message within the same minute
		await harness.session.prompt("keep going");
		await drain(harness);

		// then the user's turn and the source's next automatic turns run again
		expect(harness.faux.getCallLog().length - callsAtStop).toBeGreaterThanOrEqual(3);
	});

	it("lets a manual continue run after a pause", async () => {
		// given a source that already hit the per-minute breaker
		harness = await createHarness({ extensionFactories: [selfContinuing("goal-continuation", AUTO_TURN_ATTEMPTS)] });
		harness.setResponses(
			Array.from({ length: AUTO_TURN_ATTEMPTS + 6 }, (_, index) =>
				fauxAssistantMessage([fauxText(`status ${index}`)]),
			),
		);
		await harness.session.prompt("start");
		await drain(harness);
		const callsAtStop = harness.faux.getCallLog().length;

		// when the user asks to continue with a bare "."
		await harness.session.prompt(".");
		await drain(harness);

		// then the continue runs instead of being refused as an automatic turn
		expect(harness.faux.getCallLog().length).toBeGreaterThan(callsAtStop);
		expect(limitEntries(harness)).toHaveLength(1);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"still stops at the cap when the session file refuses writes",
		async () => {
			// given a source that keeps starting tool-free turns, and a session file that refuses every write once the
			// user's message is in
			let lockSessionFile = (): void => undefined;
			let limitEvents = 0;
			harness = await createHarness({
				extensionFactories: [
					armedByInput("ttsr-injection", "go", AUTO_TURN_ATTEMPTS, () => lockSessionFile()),
					(pi) => {
						pi.events.on("engine:turn-limit", () => {
							limitEvents += 1;
						});
					},
				],
				persistSession: true,
			});
			harness.setResponses(
				Array.from({ length: AUTO_TURN_ATTEMPTS + 2 }, () => fauxAssistantMessage([fauxText("the same reply")])),
			);
			await harness.session.prompt("seed");
			await drain(harness);
			const sessionFile = harness.sessionManager.getSessionFile();
			if (sessionFile === undefined) throw new Error("expected a persisted session file");
			lockSessionFile = () => chmodSync(sessionFile, 0o444);
			const callsBefore = harness.faux.getCallLog().length;

			// when one more user message arrives
			try {
				await expect(harness.session.prompt("go")).rejects.toThrow(/EACCES/);
				await drain(harness);
				harness.session.externalAdmission.admit({ delivery_id: "dx", text: "DELIVERY dx", deliverAs: "followUp" });
				await drain(harness);
			} finally {
				chmodSync(sessionFile, 0o644);
			}

			// then the in-process record still stops it at the per-minute cap, the pause is announced, and a delivery
			// arriving at the cap is settled as refused instead of staying pending
			expect(harness.faux.getCallLog().length - callsBefore).toBeLessThanOrEqual(1 + 12);
			expect(limitEvents).toBeGreaterThanOrEqual(1);
			const deliveries = harness.session.externalAdmission.list();
			expect(deliveries.pending).toEqual([]);
			expect(deliveries.failed?.map((failure) => failure.delivery_id)).toEqual(["dx"]);
			expect(
				harness.session.messages.filter(
					(message) => message.role === "custom" && message.content === "DELIVERY dx",
				),
			).toEqual([]);
		},
	);

	it("lets an edited user message lift a pause, like a new one", async () => {
		// given a source that already hit the per-minute breaker
		let api: ExtensionAPI | undefined;
		harness = await createHarness({
			extensionFactories: [
				selfContinuing("goal-continuation", AUTO_TURN_ATTEMPTS),
				(pi) => {
					api = pi;
				},
			],
		});
		harness.setResponses(
			Array.from({ length: AUTO_TURN_ATTEMPTS + 6 }, (_, index) =>
				fauxAssistantMessage([fauxText(`status ${index}`)]),
			),
		);
		await harness.session.prompt("start");
		await drain(harness);
		expect(limitEntries(harness)).toHaveLength(1);
		const userEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (userEntry === undefined || api === undefined)
			throw new Error("expected the user entry and the extension api");
		const callsAtStop = harness.faux.getCallLog().length;

		// when the user edits their message and an automatic turn is requested
		await harness.session.editUserMessage(userEntry.id, "start again");
		api.sendMessage({ customType: "goal-continuation", content: "continue", display: false }, { triggerTurn: true });
		await drain(harness);

		// then the edit counts as the user's latest message and the turn runs
		expect(harness.faux.getCallLog().length).toBeGreaterThan(callsAtStop);
	});
});
