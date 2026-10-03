import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal, updateGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import type { GoalStatus } from "../../src/core/extensions/builtin/goal/types.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { GOAL_CONTINUATION_MESSAGE_TYPE } from "../../src/core/messages.ts";
import { createHarness, type Harness } from "./harness.ts";

const PROVIDER_ERROR_BLOCKED_REASON = "provider error ended the turn (retries exhausted)";
const INTENTIONAL_BLOCKED_REASON = "Waiting on a user decision";
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

function goalContinuationCount(harness: Harness): number {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === GOAL_CONTINUATION_MESSAGE_TYPE).length;
}

async function createProviderBlockedHarness(): Promise<{
	harness: Harness;
	ref: ReturnType<typeof goalStoreRef>;
	statusesAtAgentStart: Array<GoalStatus | null>;
}> {
	const statusesAtAgentStart: Array<GoalStatus | null> = [];
	let ref: ReturnType<typeof goalStoreRef> | undefined;
	const observeGoalAtAgentStart = (pi: ExtensionAPI) => {
		pi.on("agent_start", async () => {
			statusesAtAgentStart.push(ref ? ((await readGoal(ref))?.status ?? null) : null);
		});
	};
	const harness = await createHarness({
		persistSession: true,
		settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } },
		extensionFactories: [goalExtension, observeGoalAtAgentStart],
	});
	harnesses.push(harness);
	ref = goalStoreRef(harness.sessionManager, harness.tempDir);
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Resume this goal after a provider outage" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "SENPI_TEST_TERMINAL_PROVIDER_ERROR",
		}),
	]);

	await harness.session.prompt("create the recovery goal");

	expect(await readGoal(ref)).toMatchObject({
		status: "blocked",
		blockedReason: PROVIDER_ERROR_BLOCKED_REASON,
	});
	return { harness, ref, statusesAtAgentStart };
}

function completionResponses() {
	return [
		fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("goal recovered and completed"),
	];
}

describe("provider-error goal recovery through the real AgentSession", () => {
	it("reactivates a provider-error block before the next direct user run", async () => {
		const { harness, ref, statusesAtAgentStart } = await createProviderBlockedHarness();
		harness.setResponses(completionResponses());

		await harness.session.prompt("retry the blocked goal");

		expect(statusesAtAgentStart).toEqual([null, "active"]);
		expect(await readGoal(ref)).toMatchObject({ status: "complete" });
	});

	it("does not auto-continue after an exhausted provider error", async () => {
		const { harness, ref, statusesAtAgentStart } = await createProviderBlockedHarness();

		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(harness.eventsOfType("agent_end")[0]?.willRetry).toBe(false);
		expect(goalContinuationCount(harness)).toBe(0);
		expect(harness.faux.state.callCount).toBe(2);

		harness.setResponses(completionResponses());
		await harness.session.prompt("resume exactly once");

		expect(statusesAtAgentStart).toEqual([null, "active"]);
		expect(harness.faux.state.callCount).toBe(4);
		expect(goalContinuationCount(harness)).toBe(0);
		expect(await readGoal(ref)).toMatchObject({ status: "complete" });
	});

	it("keeps a deliberate block blocked on direct user input", async () => {
		const statusesAtAgentStart: Array<GoalStatus | null> = [];
		let ref: ReturnType<typeof goalStoreRef> | undefined;
		const observeGoalAtAgentStart = (pi: ExtensionAPI) => {
			pi.on("agent_start", async () => {
				statusesAtAgentStart.push(ref ? ((await readGoal(ref))?.status ?? null) : null);
			});
		};
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [goalExtension, observeGoalAtAgentStart],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		await createGoal(ref, "Wait for a user decision");
		const deliberatelyBlocked = await updateGoal(
			ref,
			{ status: "blocked", reason: INTENTIONAL_BLOCKED_REASON },
			"model",
		);
		expect(deliberatelyBlocked.blockedAt).toEqual(expect.any(Number));
		harness.setResponses([fauxAssistantMessage("the block remains intentional")]);

		await harness.session.prompt("inspect without resuming");

		expect(statusesAtAgentStart).toEqual(["blocked"]);
		expect(await readGoal(ref)).toMatchObject({
			status: "blocked",
			blockedReason: INTENTIONAL_BLOCKED_REASON,
			blockedAt: deliberatelyBlocked.blockedAt,
		});
	});
});
