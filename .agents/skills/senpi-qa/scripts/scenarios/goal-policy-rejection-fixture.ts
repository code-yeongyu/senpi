import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../../../../../packages/ai/src/providers/faux.ts";
import { readGoal } from "../../../../../packages/coding-agent/src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../../../packages/coding-agent/src/core/extensions/builtin/goal/store-ref.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../../../packages/coding-agent/src/core/extensions/types.ts";

// Only loaded explicitly by goal-policy-rejection-qa.mjs in its isolated CLI.
export default function policyRecoveryFixture(pi: ExtensionAPI): void {
	const scenario = process.env.SENPI_QA_POLICY_CASE;
	if (scenario !== "policy" && scenario !== "infrastructure") throw new Error("Unknown policy QA scenario");
	// The faux provider stamps its own `api` onto every response, so the policy
	// lane must register under the Codex API id: that identity is exactly what the
	// predicate requires before trusting the unstructured diagnostic. The
	// infrastructure lane keeps a non-Codex api, which also proves the identity
	// gate does not swallow ordinary provider failures.
	const faux = fauxProvider({
		api: scenario === "policy" ? "openai-codex-responses" : "faux-policy-qa",
		provider: "faux-policy-qa",
		models: [{ id: "policy-qa", contextWindow: 1_000_000, maxTokens: 4_096 }],
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("create_goal", { objective: "QA preserve unfinished work" }, { id: "qa-create" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: scenario === "policy"
				? "Codex error: This request was blocked by our safety systems. Reason: Potentially unintended activity."
				: "upstream connection closed",
		}),
		fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }, { id: "qa-complete" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("QA_RECOVERY_COMPLETE"),
	]);
	pi.registerProvider(faux.provider);
	let context: ExtensionContext | undefined;
	let createdGoalId: string | undefined;
	const endings: Array<{ stopReason?: string; errorMessage?: string; willRetry?: boolean }> = [];
	pi.on("session_start", (_event, ctx) => { context = ctx; });
	pi.on("agent_end", async (event, ctx) => {
		context = ctx;
		const goal = await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd));
		createdGoalId ??= goal?.id;
		const lastAssistant = event.messages.findLast((message) => message.role === "assistant");
		if (lastAssistant?.role === "assistant") {
			endings.push({ stopReason: lastAssistant.stopReason, errorMessage: lastAssistant.errorMessage, willRetry: event.willRetry });
		}
	});
	pi.rpc.handle("qa.policy.snapshot", async () => {
		if (context === undefined) throw new Error("QA session has not started");
		const branch = context.sessionManager.getBranch();
		return {
			scenario,
			calls: faux.state.callCount,
			createdGoalId,
			goal: await readGoal(goalStoreRef(context.sessionManager, context.cwd)),
			endings,
			continuations: branch.filter((entry) => entry.type === "custom_message" && entry.customType === "goal-continuation").length,
			pending: context.hasPendingMessages(),
		};
	});
}
