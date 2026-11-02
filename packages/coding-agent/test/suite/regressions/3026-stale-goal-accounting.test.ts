import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from "node:timers";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashAssistantText } from "../../../src/core/extensions/builtin/goal/continuation.ts";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal, writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function nextIdle(harness: Harness): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = setRealTimeout(() => {
			unsubscribe();
			reject(new Error("Background turn did not reach agent_idle"));
		}, 5_000);
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "agent_idle") return;
			clearRealTimeout(deadline);
			unsubscribe();
			resolve();
		});
	});
}

// senpi#3026: background delivery usage follows the goal's open accounting window.
describe("senpi#3026 goal usage excludes stale-stopped background work", () => {
	// senpi#3053: retire the already-open window when a live turn trips stale admission.
	it.each(["sendUserMessage", "triggerTurn delivery"] as const)(
		"%s adds no usage after an in-session stale stop and keeps the committed totals",
		async (source) => {
			vi.useFakeTimers();
			vi.setSystemTime(1_000_000);
			let api: ExtensionAPI | undefined;
			const harness = await createHarness({
				persistSession: true,
				extensionFactories: [
					goalExtension,
					(pi) => {
						api = pi;
						pi.on("agent_start", () => {
							vi.setSystemTime(Date.now() + 5_000);
						});
					},
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({ mode: "rpc" });
			if (!api) throw new Error("Expected bound extension API");
			const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
			const created = await createGoal(ref, "Complete the registered goal");
			const output = "Background work finished";
			await writeGoal(ref, {
				...created,
				tokensUsed: 23,
				timeUsedSeconds: 17,
				consecutiveContinuations: 2,
				lastContinuationSignature: `${created.id}:0/0:${hashAssistantText(output)}`,
			});
			expect((await readGoal(ref))?.continuationStoppedAt).toBeUndefined();
			harness.setResponses([fauxAssistantMessage(output), fauxAssistantMessage(output)]);

			const activeIdle = nextIdle(harness);
			api.sendUserMessage("Extension-requested work before the stop");
			await activeIdle;

			const stopped = await readGoal(ref);
			if (!stopped) throw new Error("Expected stopped goal");
			const assistant = harness
				.eventsOfType("agent_end")[0]
				?.messages.findLast((message) => message.role === "assistant");
			if (assistant?.role !== "assistant") throw new Error("Expected accounted assistant response");
			const tokens = assistant.usage.input + assistant.usage.output;
			expect(tokens).toBeGreaterThan(0);
			expect(stopped).toMatchObject({
				status: "active",
				tokensUsed: 23 + tokens,
				timeUsedSeconds: 22,
				continuationStoppedAt: 1_005_000,
			});
			expect(stopped.lastStartedAt).toBeUndefined();
			expect(harness.sessionManager.getBranch()).toContainEqual(
				expect.objectContaining({
					type: "custom",
					customType: "goal-continuation-stopped",
					data: expect.objectContaining({ reason: "stale" }),
				}),
			);

			const stoppedIdle = nextIdle(harness);
			if (source === "sendUserMessage") api.sendUserMessage("Extension-requested work after the stop");
			else {
				api.sendMessage(
					{ customType: "external-delivery", content: "Delivered work after the stop", display: false },
					{ triggerTurn: true },
				);
			}
			await stoppedIdle;

			expect(harness.faux.getCallLog()).toHaveLength(2);
			expect(harness.eventsOfType("agent_start")).toHaveLength(2);
			expect(await readGoal(ref)).toMatchObject({
				tokensUsed: stopped.tokensUsed,
				timeUsedSeconds: stopped.timeUsedSeconds,
				continuationStoppedAt: stopped.continuationStoppedAt,
			});
			expect((await readGoal(ref))?.lastStartedAt).toBeUndefined();
		},
	);

	it.each([
		["sendUserMessage", false, "counts", 5],
		["sendUserMessage", true, "excludes", 0],
		["triggerTurn delivery", false, "counts", 5],
		["triggerTurn delivery", true, "excludes", 0],
	] as const)(
		"%s with staleStopped=%s %s tokens and adds %s seconds",
		async (source, staleStopped, _accounting, addedSeconds) => {
			vi.useFakeTimers();
			vi.setSystemTime(1_000_000);
			let api: ExtensionAPI | undefined;
			const harness = await createHarness({
				persistSession: true,
				extensionFactories: [
					goalExtension,
					(pi) => {
						api = pi;
						// Keep automatic goal work parked; fake timers never fire the backstop.
						pi.on("session_start", () => pi.events.emit("terminal_monitor_state", { activeCount: 1 }));
						pi.on("agent_start", () => {
							vi.setSystemTime(Date.now() + 5_000);
						});
					},
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({ mode: "rpc" });
			if (!api) throw new Error("Expected bound extension API");
			const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
			const created = await createGoal(ref, "Complete the registered goal");
			const initial = {
				...created,
				tokensUsed: 23,
				timeUsedSeconds: 17,
				...(staleStopped ? { continuationStoppedAt: Date.now() } : {}),
			};
			if (staleStopped) delete initial.lastStartedAt;
			await writeGoal(ref, initial);
			harness.setResponses([fauxAssistantMessage("Background work finished")]);

			const idle = nextIdle(harness);
			if (source === "sendUserMessage") api.sendUserMessage("Extension-requested work");
			else {
				api.sendMessage(
					{ customType: "external-delivery", content: "Delivered work", display: false },
					{ triggerTurn: true },
				);
			}
			await idle;

			expect(harness.faux.getCallLog()).toHaveLength(1);
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
			const assistant = harness
				.eventsOfType("agent_end")[0]
				?.messages.find((message) => message.role === "assistant");
			if (assistant?.role !== "assistant") throw new Error("Expected accounted assistant response");
			const tokens = assistant.usage.input + assistant.usage.output;
			expect(tokens).toBeGreaterThan(0);
			expect(await readGoal(ref)).toMatchObject({
				status: "active",
				tokensUsed: initial.tokensUsed + (staleStopped ? 0 : tokens),
				timeUsedSeconds: initial.timeUsedSeconds + addedSeconds,
			});
			if (staleStopped) {
				expect(await readGoal(ref)).toMatchObject({ continuationStoppedAt: initial.continuationStoppedAt });
				expect((await readGoal(ref))?.lastStartedAt).toBeUndefined();
			}
		},
	);
});
