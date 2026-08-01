import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal, updateGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import { TODO_STATE_ENTRY_TYPE } from "../../../src/core/extensions/builtin/todotools/todo-types.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: ((value: T) => void) | undefined;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

async function awaitSignal<T>(promise: Promise<T>, label: string): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(`Timed out awaiting ${label}`)), 2_000);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

describe("automatic compaction timeout recovery", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("recovers Goal, todo, and queued input through the real overflow route", async () => {
		const watchdog = { idleTimeoutMs: 1_000, maxDurationMs: 5 };
		const inflate: AgentTool = {
			name: "inflate",
			label: "Inflate",
			description: "Create old context for automatic compaction.",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `old tool result ${"context ".repeat(10_000)}` }],
				details: {},
			}),
		};
		harness = await createHarness({
			persistSession: true,
			models: [{ id: "faux-compact", contextWindow: 20_000, maxTokens: 512 }],
			tools: [inflate],
			initialActiveToolNames: ["inflate"],
			settings: {
				compaction: {
					enabled: false,
					reserveTokens: 5_000,
					keepRecentTokens: 1,
					speculativeEnabled: false,
					idleCompactionEnabled: false,
				},
			},
			extensionFactories: [(pi) => compactionExtension(pi, { summarizationWatchdog: watchdog }), goalExtension],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("inflate", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("seed turn complete"),
		]);
		await harness.session.prompt("build old recovery context");

		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		const privateObjectiveTail = "PRIVATE_GOAL_TAIL_MUST_NOT_ENTER_SESSION";
		const goal = await createGoal(
			ref,
			`Finish automatic compaction recovery\n${"bounded objective ".repeat(300)}\n${privateObjectiveTail}`,
		);
		await updateGoal(ref, { status: "blocked", reason: "continuation cap reached" }, "model");
		harness.sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, {
			schema: "v2",
			phases: [
				{
					name: "Recovery",
					tasks: [{ content: "Preserve queued recovery state", status: "in_progress" }],
				},
			],
		});
		const summaryStarted = deferred<void>();
		const goalReactivated = deferred<void>();
		const compactionEnded = deferred<Extract<AgentSessionEvent, { type: "compaction_end" }>>();
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.reason === "overflow") {
				compactionEnded.resolve(event);
			}
		});
		const enableAutomaticCompaction: FauxResponseFactory = async () => {
			const reactivated = await readGoal(ref);
			if (reactivated?.id !== goal.id || reactivated.status !== "active") {
				throw new Error("Expected accepted prompt to reactivate the blocked Goal");
			}
			goalReactivated.resolve();
			await updateGoal(ref, { status: "paused" }, "user");
			harness?.settingsManager.applyOverrides({
				compaction: {
					enabled: true,
					reserveTokens: 5_000,
					keepRecentTokens: 1,
					speculativeEnabled: false,
					idleCompactionEnabled: false,
				},
			});
			return fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage:
					"Error Code context_too_large: Your input exceeds the context window of this model. Please adjust your input and try again.",
			});
		};
		const hangingSummary: FauxResponseFactory = () => {
			summaryStarted.resolve();
			return new Promise<never>(() => {});
		};
		harness.setResponses([
			enableAutomaticCompaction,
			hangingSummary,
			fauxAssistantMessage("overflow retry handled"),
			fauxAssistantMessage("queued user input handled"),
		]);

		const prompt = harness.session.prompt("current recovery request");
		await awaitSignal(goalReactivated.promise, "Goal reactivation");
		await awaitSignal(summaryStarted.promise, "summary request");
		await harness.session.followUp("queued during automatic compaction");
		expect(await readGoal(ref)).toMatchObject({ id: goal.id, status: "paused" });

		const compactionEnd = await awaitSignal(compactionEnded.promise, "compaction end");
		expect(compactionEnd).toMatchObject({ accepted: true, aborted: false });
		await awaitSignal(prompt, "initial prompt");
		await awaitSignal(harness.session.waitForSettledSessionWork(), "settled session work");

		const compaction = harness.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "compaction" &&
					typeof entry.details === "object" &&
					entry.details !== null &&
					"schema" in entry.details &&
					entry.details.schema === "senpi.compaction.deterministic-fallback.v1",
			);
		if (compaction?.type !== "compaction") throw new Error("Expected deterministic fallback entry");
		expect(compaction.summary).toContain("Preserve queued recovery state");
		expect(compaction.summary).toContain("Finish automatic compaction recovery");
		expect(compaction.summary).not.toContain(privateObjectiveTail);
		expect(compaction.details).not.toHaveProperty("taskIntent");
		expect(getUserTexts(harness).filter((text) => text === "queued during automatic compaction")).toHaveLength(1);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.agent.hasQueuedMessages()).toBe(false);

		const diagnostic = readFileSync(join(harness.tempDir, "logs", "compaction.log"), "utf8");
		expect(diagnostic).toContain('"event":"deterministic_fallback_applied"');
		expect(diagnostic).not.toContain("Preserve queued recovery state");
	});
});
