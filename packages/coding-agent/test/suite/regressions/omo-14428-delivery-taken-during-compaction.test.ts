/**
 * omo#14428: a compaction requested while a run was ending detached the session from its agent's events and did
 * not stop the run's own continuation. That continuation took the queued peer deliveries, and nobody heard their
 * `message_end`: no transcript entry, and the ledger kept them pending for the life of the process, so their
 * sender never delivered them again. A run that overlaps a compaction is recorded like any other.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/index.ts";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/types.ts";
import { deliveryIdOf } from "../../../src/core/delivery-ids.ts";
import { createHarness, type Harness } from "../harness.ts";

interface Scene {
	/** Runs once, inside the next run's `agent_end` handlers: the window in which that run is ending. */
	atRunEnd?: (ctx: ExtensionContext) => void;
	/** The next `agent_before_settle` asks for one more request, as a goal continuation does. */
	continueOnce: boolean;
	/** Set once the compaction asked for its summary: it was a real compaction, not a refused request. */
	summaryRequested: boolean;
	readonly compactionMayFinish: PromiseWithResolvers<void>;
}

function newScene(): Scene {
	return { continueOnce: false, summaryRequested: false, compactionMayFinish: Promise.withResolvers<void>() };
}

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function compactableSession(scene: Scene): Promise<Harness> {
	const target = await createHarness({
		persistSession: true,
		models: [{ id: "omo-14428", contextWindow: 128_000, maxTokens: 64 }],
		settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
		extensionFactories: [
			(pi: ExtensionAPI) => {
				pi.on("session_before_compact", async (event) => {
					scene.summaryRequested = true;
					await scene.compactionMayFinish.promise;
					return {
						compaction: {
							summary: "summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
				pi.on("agent_end", (_event, ctx) => {
					const act = scene.atRunEnd;
					scene.atRunEnd = undefined;
					act?.(ctx);
				});
				pi.on("agent_before_settle", () => {
					const asked = scene.continueOnce;
					scene.continueOnce = false;
					return asked ? { continue: true } : undefined;
				});
			},
		],
	});
	harnesses.push(target);
	await target.session.bindExtensions({});
	target.setResponses([fauxAssistantMessage("seed reply")]);
	await target.session.prompt("seed context ".repeat(40));
	await target.session.waitForIdle();
	return target;
}

function sessionEvent(target: Harness, type: string): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = target.session.subscribe((event) => {
			if (event.type !== type) return;
			unsubscribe();
			resolve();
		});
	});
}

/** Counted on the agent itself, which reports every run it ends whether or not the session is listening. */
function agentRunsEnded(target: Harness, count: number): Promise<void> {
	return new Promise((resolve) => {
		let ended = 0;
		const unsubscribe = target.agent.subscribe((event) => {
			if (event.type !== "agent_end" || ++ended < count) return;
			unsubscribe();
			resolve();
		});
	});
}

function deliveredIds(target: Harness): readonly (string | undefined)[] {
	return target.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === SESSION_CONTROL_DELIVERY_TYPE
				? [deliveryIdOf({ role: "custom", ...entry, display: entry.display, timestamp: 0 })]
				: [],
		);
}

type CompactionRequest = (target: Harness, ctx: ExtensionContext) => void;

const COMPACTION_REQUESTS: readonly (readonly [string, CompactionRequest])[] = [
	["a manual compaction", (target) => void target.session.compact().catch(() => undefined)],
	["an extension's ctx.compact()", (_target, ctx) => ctx.compact()],
];

describe("omo#14428 a delivery taken by a run that overlaps a compaction", () => {
	it.each(COMPACTION_REQUESTS)(
		"is written when the run that ends under %s continues with it",
		async (_name, requestCompaction) => {
			const scene = newScene();
			const target = await compactableSession(scene);
			const admission = target.session.externalAdmission;
			const continuationRequested = Promise.withResolvers<void>();
			target.setResponses([
				fauxAssistantMessage("work done"),
				() => {
					continuationRequested.resolve();
					return fauxAssistantMessage("ack f-1");
				},
			]);
			let admitted: string | undefined;
			scene.atRunEnd = (ctx) => {
				admitted = admission.admit({ delivery_id: "f-1", text: "from a peer", deliverAs: "followUp" }).kind;
				requestCompaction(target, ctx);
			};
			const compactionEnded = sessionEvent(target, "compaction_end");
			const bothRunsEnded = agentRunsEnded(target, 2);

			const prompted = target.session.prompt("work");
			await continuationRequested.promise;
			scene.compactionMayFinish.resolve();
			await Promise.all([prompted, compactionEnded, bothRunsEnded]);

			expect(admitted).toBe("queued");
			expect(scene.summaryRequested).toBe(true);
			expect(deliveredIds(target)).toEqual(["f-1"]);
			await target.session.waitForIdle();
			expect(admission.list()).toEqual({ pending: [], emitted: ["f-1"] });
		},
	);

	it("is written when a follow-up queued behind a provider error starts under a compaction (#6868)", async () => {
		const scene = newScene();
		const target = await compactableSession(scene);
		const admission = target.session.externalAdmission;
		const failNow = Promise.withResolvers<void>();
		const continuationRequested = Promise.withResolvers<void>();
		target.setResponses([
			async () => {
				await failNow.promise;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request: context rejected" });
			},
			() => {
				continuationRequested.resolve();
				return fauxAssistantMessage("ack f-1");
			},
		]);
		scene.atRunEnd = () => {
			scene.continueOnce = true;
			void target.session.compact().catch(() => undefined);
		};
		const compactionEnded = sessionEvent(target, "compaction_end");
		const bothRunsEnded = agentRunsEnded(target, 2);

		const running = sessionEvent(target, "agent_start");
		const prompted = target.session.prompt("work").catch(() => undefined);
		await running;
		expect(admission.admit({ delivery_id: "f-1", text: "from a peer", deliverAs: "followUp" }).kind).toBe("queued");
		failNow.resolve();
		await continuationRequested.promise;
		scene.compactionMayFinish.resolve();
		await Promise.all([prompted, compactionEnded, bothRunsEnded]);

		expect(scene.summaryRequested).toBe(true);
		expect(deliveredIds(target)).toEqual(["f-1"]);
		await target.session.waitForIdle();
		expect(admission.list()).toEqual({ pending: [], emitted: ["f-1"] });
	});
});
