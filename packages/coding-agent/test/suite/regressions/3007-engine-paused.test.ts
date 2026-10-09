import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { admitAndQueueGoalContinuation } from "../../../src/core/extensions/builtin/goal/lifecycle-helpers.ts";
import { createGoal, writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import ttsrExtension from "../../../src/core/extensions/builtin/ttsr/index.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function setup(options: Parameters<typeof createHarness>[0] = {}) {
	const harness = await createHarness({ ...options, persistSession: true });
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: "rpc" });
	return harness;
}

function paused(harness: Harness) {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "engine-paused");
}

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

async function promptToIdle(harness: Harness, text: string) {
	const idle = nextIdle(harness);
	await harness.session.prompt(text);
	await idle;
}

function checkReplay(harness: Harness) {
	const file = harness.sessionManager.getSessionFile();
	if (!file) throw new Error("expected persisted session");
	const stopEntries = harness.sessionManager
		.getEntries()
		.filter(
			(entry) =>
				entry.type === "custom" && ["engine-paused", "goal-continuation-stopped"].includes(entry.customType),
		);
	expect(stopEntries.length).toBeGreaterThan(0);
	expect(
		SessionManager.open(file)
			.getEntries()
			.filter((entry) => stopEntries.some((stop) => stop.id === entry.id)),
	).toEqual(stopEntries);
	expect(
		harness
			.eventsOfType("entry_appended")
			.filter((event) => stopEntries.some((stop) => stop.id === event.entry.id))
			.map((event) => event.entry),
	).toEqual(stopEntries);
}

describe("senpi#3007 durable engine pause signals", () => {
	it.each([
		["cap-per-message", { maxPerUserInput: 2, maxToolFreePerMinute: 0 }],
		["cap-per-minute", { maxPerUserInput: 0, maxToolFreePerMinute: 2 }],
	] as const)("emits %s once alongside the engine turn limit and replays it", async (reason, engineTurns) => {
		let sent = 0;
		const harness = await setup({
			settings: { engineTurns },
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (++sent > 4) return;
						pi.sendMessage(
							{ customType: "auto-work", content: "continue", display: false },
							{ triggerTurn: true },
						);
					});
				},
			],
		});
		harness.setResponses(Array.from({ length: 5 }, (_, n) => fauxAssistantMessage(`distinct response ${n}`)));
		await promptToIdle(harness, "start");
		expect(paused(harness)).toHaveLength(1);
		expect(paused(harness)[0]).toMatchObject({
			data: { reason, customType: "auto-work", count: 2, at: expect.any(Number) },
		});
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "engine-turn-limit"),
		).toHaveLength(1);
		checkReplay(harness);
	});

	it("emits repetition once when a stream rule repeats after its correction", async () => {
		const harness = await setup({ extensionFactories: [ttsrExtension] });
		harness.setResponses([
			fauxAssistantMessage(`analyzing ${"!".repeat(600)}`),
			fauxAssistantMessage(`again ${"!".repeat(600)}`),
		]);
		await promptToIdle(harness, "work");
		expect(paused(harness)).toHaveLength(1);
		expect(paused(harness)[0]).toMatchObject({
			data: { reason: "repetition", rule: expect.any(String), customType: "ttsr-injection", at: expect.any(Number) },
		});
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "ttsr-loop-stopped"),
		).toHaveLength(1);
		checkReplay(harness);
	});

	it("records a repetitive-turns correction only at final idle, not when another turn starts", async () => {
		for (const continueAgain of [true, false]) {
			let afterCorrection = false;
			const harness = await setup({
				extensionFactories: [
					ttsrExtension,
					(pi) => {
						pi.on("message_start", (event) => {
							if (event.message.role === "custom" && event.message.customType === "ttsr-injection")
								afterCorrection = true;
						});
						pi.on("agent_settled", () => {
							if (!continueAgain || !afterCorrection) return;
							afterCorrection = false;
							pi.sendMessage(
								{ customType: "other-work", content: "do more", display: false },
								{ triggerTurn: true },
							);
						});
					},
				],
			});
			const status = "Still working on the frobnicate step. Pass 1 of 9 is done, queue drained here.";
			harness.setResponses([
				fauxAssistantMessage([fauxText(status)]),
				fauxAssistantMessage([fauxText(status)]),
				fauxAssistantMessage("The widget is implemented and the verification result is ready."),
				fauxAssistantMessage("Other work finished."),
			]);
			await promptToIdle(harness, "start");
			await promptToIdle(harness, "continue");
			const corrections = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "ttsr-injection");
			expect(corrections).toHaveLength(1);
			if (continueAgain) {
				// The correction did not self-stop when another owner started a turn.
				expect(paused(harness)).toEqual([]);
			} else {
				expect(paused(harness)).toHaveLength(1);
				expect(paused(harness)[0]).toMatchObject({
					data: {
						reason: "repetition",
						rule: "repetitive-turns",
						customType: "ttsr-injection",
						at: expect.any(Number),
					},
				});
				checkReplay(harness);
			}
		}
	});

	it("delivers goal-stale and goal-continuation-stopped through entry_appended and reopen", async () => {
		const extension = (pi: ExtensionAPI) => {
			pi.on("agent_settled", async (_event, ctx) => {
				const ref = goalStoreRef(ctx.sessionManager, ctx.cwd);
				const created = await createGoal(ref, "Stop the stale goal");
				const goal = {
					...created,
					consecutiveContinuations: 2,
					unattendedContinuations: 2,
					lastContinuationSignature: "same",
				};
				await writeGoal(ref, goal);
				await admitAndQueueGoalContinuation(pi, ctx, goal, {
					input: {
						isIdle: true,
						hasPendingMessages: false,
						path: "immediate",
						lastStopReason: "stop",
						lastTurnWasMalformedToolUse: false,
						consecutiveContinuations: 2,
						lastContinuationSignature: "same",
						currentSignature: "same",
						consecutiveLengthRecoveries: 0,
						recentNormalizedOutputHashes: [],
						toollessContinuationStreak: 0,
						continuationPending: false,
						lastTurnStuckOnContextOverflow: false,
					},
					content: () => "continue",
					markContinuationPending: () => {},
				});
			});
		};
		const harness = await setup({ extensionFactories: [extension] });
		harness.setResponses([fauxAssistantMessage("done")]);
		await promptToIdle(harness, "start");
		expect(paused(harness)).toHaveLength(1);
		expect(paused(harness)[0]).toMatchObject({
			data: { reason: "goal-stale", customType: "goal-continuation", count: 2, at: expect.any(Number) },
		});
		checkReplay(harness);
	});
});
