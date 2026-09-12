import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENAI_CODEX_MODELS } from "../../../ai/src/providers/openai-codex.models.ts";
import { readGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import type { AgentEndEvent } from "../../src/core/extensions/types.ts";
import {
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "./goal-monitor-test-harness.ts";

const CODEX_POLICY_ERROR =
	"Codex error: This request was blocked by our safety systems. Reason: Potentially unintended activity.";

// The predicate's Codex identity is a literal copy of the api id the shipped
// Codex catalog stamps on every message. Reading the catalog back keeps the two
// pinned together: renaming the api in `packages/ai` fails here instead of
// silently disarming the #1520 guard while every hardcoded case stays green.
const CODEX_CATALOG_APIS = [...new Set(Object.values(OPENAI_CODEX_MODELS).map((model) => model.api))];

// `fauxAssistantMessage` hardcodes `api`, so the Codex identity this predicate
// now requires has to be applied to the returned message.
function codexPolicyMessage() {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: CODEX_POLICY_ERROR }),
		api: "openai-codex-responses" as const,
	};
}

async function setupGoal() {
	const harness = createGoalHarness();
	const ctx = await makeGoalContext([], "policy-rejection");
	const create = harness.tools.get("create_goal");
	if (create === undefined) throw new Error("create_goal was not registered");
	await create.execute("create", { objective: "Preserve unfinished work" }, undefined, undefined, ctx);
	const goal = await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd));
	await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
	return { harness, ctx, goal };
}

afterEach(async () => {
	vi.useRealTimers();
	await cleanupGoalMonitorTempDirs();
});

describe("terminal policy goal recovery", () => {
	// Regression for #1520: exercise agent_end routing through the real monitor's
	// agent_settled admission and sendMessage, not just the error predicate.
	it.each([
		["Codex backend policy error", codexPolicyMessage()],
		["structured refusal", fauxAssistantMessage("", { stopReason: "error", stopDetails: { type: "refusal" } })],
		[
			"structured sensitive stop",
			fauxAssistantMessage("", { stopReason: "error", stopDetails: { type: "sensitive" } }),
		],
		[
			"refusal with empty toolUse",
			fauxAssistantMessage("", { stopReason: "toolUse", stopDetails: { type: "refusal" } }),
		],
		[
			"sensitive empty toolUse",
			fauxAssistantMessage("", { stopReason: "toolUse", stopDetails: { type: "sensitive" } }),
		],
		[
			"Anthropic policy error",
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage:
					"This request triggered restrictions on output and was blocked under Anthropic's Usage Policy",
			}),
		],
	])("blocks %s without consuming a continuation or losing the goal", async (_name, message) => {
		const { harness, ctx, goal } = await setupGoal();
		const event: AgentEndEvent = { type: "agent_end", messages: [message], willRetry: false };

		await runGoalHandlers(harness.handlers, "agent_end", event, ctx);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);

		expect(harness.sent).toHaveLength(0);
		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({
			id: goal?.id,
			objective: goal?.objective,
			status: "blocked",
			consecutiveContinuations: 0,
			unattendedContinuations: 0,
		});
	});

	it.each([
		["overload", "overloaded_error", undefined],
		["unknown infrastructure", "upstream connection closed", undefined],
		["provider watchdog", "Idle timeout waiting for provider stream after 1000ms", "provider"],
		["system recovery", "Provider stream start timed out after 1000ms", "system"],
	] as const)("preserves one settled recovery for %s", async (_name, errorMessage, abortSource) => {
		const { harness, ctx, goal } = await setupGoal();
		const event: AgentEndEvent = {
			type: "agent_end",
			messages: [fauxAssistantMessage("", { stopReason: "error", errorMessage })],
			willRetry: false,
			abortSource,
			aborted: abortSource !== undefined,
		};

		await runGoalHandlers(harness.handlers, "agent_end", event, ctx);
		expect(harness.sent).toHaveLength(0);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);

		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.message.customType).toBe("goal-continuation");
		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({
			id: goal?.id,
			status: "active",
			consecutiveContinuations: 1,
			unattendedContinuations: 1,
		});
	});

	it.each([CODEX_POLICY_ERROR, "overloaded_error"])(
		"leaves an explicit retry owner in control: %s",
		async (errorMessage) => {
			const { harness, ctx } = await setupGoal();
			await runGoalHandlers(
				harness.handlers,
				"agent_end",
				{
					type: "agent_end",
					messages: [fauxAssistantMessage("", { stopReason: "error", errorMessage })],
					willRetry: true,
				},
				ctx,
			);
			await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);

			expect(harness.sent).toHaveLength(0);
			expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({
				status: "active",
				consecutiveContinuations: 0,
			});
		},
	);

	// The unstructured diagnostic is Codex-specific and carries no policy code, so
	// matching it on any provider would strand an otherwise recoverable goal on a
	// gateway that happens to emit the same sentence.
	it.each([
		["anthropic-messages", "anthropic-messages"],
		["an unknown gateway", "openai-completions"],
	])("recovers instead of blocking when %s reports the same diagnostic", async (_name, api) => {
		const { harness, ctx, goal } = await setupGoal();
		const event: AgentEndEvent = {
			type: "agent_end",
			messages: [{ ...codexPolicyMessage(), api }],
			willRetry: false,
		};

		await runGoalHandlers(harness.handlers, "agent_end", event, ctx);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);

		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.message.customType).toBe("goal-continuation");
		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({
			id: goal?.id,
			status: "active",
		});
	});

	it.each(CODEX_CATALOG_APIS)("blocks the diagnostic on the shipped Codex catalog api %s", async (api) => {
		const { harness, ctx, goal } = await setupGoal();
		const event: AgentEndEvent = {
			type: "agent_end",
			messages: [{ ...codexPolicyMessage(), api }],
			willRetry: false,
		};

		await runGoalHandlers(harness.handlers, "agent_end", event, ctx);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);

		expect(harness.sent).toHaveLength(0);
		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({
			id: goal?.id,
			status: "blocked",
			consecutiveContinuations: 0,
		});
	});

	it("does not treat ordinary assistant text about safety blocks as a policy error", async () => {
		const { harness, ctx } = await setupGoal();
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{
				type: "agent_end",
				messages: [fauxAssistantMessage(CODEX_POLICY_ERROR)],
				willRetry: false,
			},
			ctx,
		);
		expect(harness.sent).toHaveLength(1);
	});

	it("disarms a live monitor backstop on policy rejection, including system abort provenance", async () => {
		vi.useFakeTimers();
		const { harness, ctx } = await setupGoal();
		harness.events.emit("terminal_monitor_state", { activeCount: 1 });
		await harness.events.flush();
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{
				type: "agent_end",
				messages: [fauxAssistantMessage("Waiting")],
				willRetry: false,
			},
			ctx,
		);
		expect(harness.events.emitted.some((event) => event.channel === "goal_continuation_scheduled")).toBe(true);

		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{
				type: "agent_end",
				aborted: true,
				abortSource: "system",
				willRetry: false,
				messages: [codexPolicyMessage()],
			},
			ctx,
		);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);
		await vi.runOnlyPendingTimersAsync();

		expect(harness.sent).toHaveLength(0);
		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({
			status: "blocked",
			consecutiveContinuations: 0,
		});
	});
});
