import { type AssistantMessage, fauxAssistantMessage, type ProviderDiagnostic } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { isMechanicalContinuationBlock } from "../../../src/core/extensions/builtin/goal/continuation-recovery.ts";
import { readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import type { AgentEndEvent, ExtensionToolContext } from "../../../src/core/extensions/types.ts";
import {
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "../goal-monitor-test-harness.ts";

// #2293: a provider that keeps rejecting the credential (401) or the access (403)
// fails the same way on every retry. The goal must block on the first terminal
// rejection with auth guidance instead of spending the continuation cap on it.

function failedTurn(
	errorMessage: string,
	identity: { api: AssistantMessage["api"]; provider: string; model: string },
	providerDiagnostic?: ProviderDiagnostic,
): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
		...identity,
		...(providerDiagnostic === undefined ? {} : { providerDiagnostic }),
	};
}

// The reported shape: GitHub Copilot answers kimi-k3 with a 403 and no body. The
// OpenAI SDK names only the status, and openai-completions mints a status-only
// diagnostic that cannot tell auth from access (category "unknown").
const COPILOT = { api: "openai-completions", provider: "github-copilot", model: "kimi-k3" } as const;
const copilotForbidden = () =>
	failedTurn("403 status code (no body)", COPILOT, {
		category: "unknown",
		httpStatus: 403,
		evidence: "structured_status",
	});

async function setupGoal() {
	const harness = createGoalHarness();
	const notices: string[] = [];
	const ctx = await makeGoalContext(notices, "provider-auth-block");
	const create = harness.tools.get("create_goal");
	if (create === undefined) throw new Error("create_goal was not registered");
	await create.execute(
		"create",
		{ objective: "Finish the migration" },
		undefined,
		undefined,
		ctx as ExtensionToolContext,
	);
	await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
	return { harness, ctx, notices, goal: await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd)) };
}

async function endTurn(setup: Awaited<ReturnType<typeof setupGoal>>, event: AgentEndEvent): Promise<void> {
	await runGoalHandlers(setup.harness.handlers, "agent_end", event, setup.ctx);
	await runGoalHandlers(setup.harness.handlers, "agent_settled", { type: "agent_settled" }, setup.ctx);
	await runGoalHandlers(setup.harness.handlers, "agent_settled", { type: "agent_settled" }, setup.ctx);
}

afterEach(async () => {
	await cleanupGoalMonitorTempDirs();
});

describe("goal blocks on a terminal provider auth rejection (#2293)", () => {
	it.each([
		["a Copilot 403 with an empty body", copilotForbidden()],
		[
			"a structured 401",
			failedTurn(
				"401 Incorrect API key provided",
				{ api: "openai-completions", provider: "openai", model: "gpt-5" },
				{
					category: "auth",
					httpStatus: 401,
					code: "invalid_api_key",
					evidence: "structured_code",
				},
			),
		],
		[
			"a 401 from an adapter without diagnostics",
			failedTurn('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', {
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-5",
			}),
		],
		[
			"a 403 from an adapter without diagnostics",
			failedTurn("403 status code (no body)", {
				api: "openai-responses",
				provider: "github-copilot",
				model: "gpt-5",
			}),
		],
	])("blocks %s on the first hit without a recovery continuation", async (_name, message) => {
		const setup = await setupGoal();

		await endTurn(setup, { type: "agent_end", messages: [message], willRetry: false });

		expect(setup.harness.sent).toHaveLength(0);
		const goal = await readGoal(goalStoreRef(setup.ctx.sessionManager, setup.ctx.cwd));
		expect(goal).toMatchObject({
			id: setup.goal?.id,
			status: "blocked",
			consecutiveContinuations: 0,
			unattendedContinuations: 0,
		});
		expect(isMechanicalContinuationBlock(goal?.blockedReason)).toBe(true);
		expect(setup.notices).toHaveLength(1);
		expect(setup.notices[0]).toContain(`${message.provider}/${message.model}`);
		expect(setup.notices[0]).toContain(`/login ${message.provider}`);
		expect(setup.notices[0]).not.toContain("continuation cap reached");
	});

	it("resumes the auth-blocked goal on the next accepted user message", async () => {
		const setup = await setupGoal();
		await endTurn(setup, { type: "agent_end", messages: [copilotForbidden()], willRetry: false });
		expect((await readGoal(goalStoreRef(setup.ctx.sessionManager, setup.ctx.cwd)))?.status).toBe("blocked");

		await runGoalHandlers(
			setup.harness.handlers,
			"input",
			{ type: "input", inputId: "after-relogin", text: "logged in again, continue", source: "interactive" },
			setup.ctx,
		);
		await runGoalHandlers(
			setup.harness.handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: "after-relogin", disposition: "started" },
			setup.ctx,
		);

		expect(await readGoal(goalStoreRef(setup.ctx.sessionManager, setup.ctx.cwd))).toMatchObject({
			id: setup.goal?.id,
			status: "active",
		});
	});

	it.each([
		[
			"a structured 429",
			failedTurn("429 Rate limit reached", COPILOT, {
				category: "rate_limit",
				httpStatus: 429,
				code: "rate_limit_exceeded",
				evidence: "structured_code",
			}),
		],
		[
			"a structured 503",
			failedTurn("503 status code (no body)", COPILOT, {
				category: "provider_unavailable",
				httpStatus: 503,
				evidence: "structured_status",
			}),
		],
		["an unstructured 429", failedTurn("429 Too Many Requests", COPILOT)],
		// The structured diagnostic is the adapter's own reading of the transport
		// error, so it outranks whatever status the message text starts with.
		[
			"a structured 502 whose text leads with 401",
			failedTurn("401 upstream said unauthorized", COPILOT, {
				category: "provider_unavailable",
				httpStatus: 502,
				evidence: "structured_status",
			}),
		],
	])("keeps one settled recovery for %s", async (_name, message) => {
		const setup = await setupGoal();

		await endTurn(setup, { type: "agent_end", messages: [message], willRetry: false });

		expect(setup.harness.sent).toHaveLength(1);
		expect(setup.harness.sent[0]?.message.customType).toBe("goal-continuation");
		expect(await readGoal(goalStoreRef(setup.ctx.sessionManager, setup.ctx.cwd))).toMatchObject({
			status: "active",
			consecutiveContinuations: 1,
		});
	});

	it("leaves an explicit retry owner in control of a 403", async () => {
		const setup = await setupGoal();

		await endTurn(setup, { type: "agent_end", messages: [copilotForbidden()], willRetry: true });

		expect(setup.harness.sent).toHaveLength(0);
		expect(setup.notices).toEqual([]);
		expect(await readGoal(goalStoreRef(setup.ctx.sessionManager, setup.ctx.cwd))).toMatchObject({
			status: "active",
			consecutiveContinuations: 0,
		});
	});

	it("does not block a turn that recovered from an earlier 401", async () => {
		const setup = await setupGoal();
		const recovered = { ...fauxAssistantMessage("Migration step done"), ...COPILOT };

		await endTurn(setup, {
			type: "agent_end",
			messages: [failedTurn("401 status code (no body)", COPILOT), recovered],
			willRetry: false,
		});

		expect(setup.harness.sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(setup.ctx.sessionManager, setup.ctx.cwd))).toMatchObject({ status: "active" });
	});

	it("does not treat assistant text about a 401 as a provider rejection", async () => {
		const setup = await setupGoal();

		await endTurn(setup, {
			type: "agent_end",
			messages: [{ ...fauxAssistantMessage("401 Unauthorized is what the API returned"), ...COPILOT }],
			willRetry: false,
		});

		expect(setup.harness.sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(setup.ctx.sessionManager, setup.ctx.cwd))).toMatchObject({ status: "active" });
	});
});
