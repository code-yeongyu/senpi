import { describe, expect, it, vi } from "vitest";
import { ModelUsabilityBudgetError } from "../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type HandleResumeSession = (
	this: ResumeContext,
	sessionPath: string,
	options?: unknown,
) => Promise<{ cancelled: boolean }>;

interface ResumeContext {
	clearStatusIndicator: () => void;
	runtimeHost: { switchSession: (sessionPath: string, options?: unknown) => Promise<{ cancelled: boolean }> };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	promptForMissingSessionCwd: (error: MissingSessionCwdError) => Promise<string | undefined>;
	createProjectTrustContext: (cwd: string) => unknown;
	cancelResumeWithBudgetError: (error: ModelUsabilityBudgetError) => { cancelled: boolean };
}

function getHandleResumeSession(): HandleResumeSession {
	const descriptor = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "handleResumeSession");
	if (!descriptor || typeof descriptor.value !== "function") {
		throw new Error("InteractiveMode.handleResumeSession is not available");
	}
	return descriptor.value as HandleResumeSession;
}

function makeBudgetError(): ModelUsabilityBudgetError {
	return new ModelUsabilityBudgetError({
		model: "faux/faux-small",
		contextWindow: 8192,
		liveContextTokens: 60000,
		systemPromptTokens: 3748,
		activeToolSchemaTokens: 4538,
		outputReserveTokens: 2048,
		compactionReserveTokens: 1024,
		speculationLeadTokens: 0,
		safetyMarginTokens: 8192,
		safetyMarginProfile: "default",
		requiredTokens: 79550,
		shortfallTokens: 71358,
		usable: false,
		admission: "resume",
	});
}

function makeContext(overrides: Partial<ResumeContext>): ResumeContext {
	const cancelResumeWithBudgetError = Object.getOwnPropertyDescriptor(
		InteractiveMode.prototype,
		"cancelResumeWithBudgetError",
	)?.value as (this: ResumeContext, error: ModelUsabilityBudgetError) => { cancelled: boolean };
	const base: ResumeContext = {
		clearStatusIndicator: vi.fn(),
		runtimeHost: { switchSession: vi.fn(async () => ({ cancelled: false })) },
		showStatus: vi.fn(),
		showError: vi.fn(),
		handleFatalRuntimeError: vi.fn(async () => {
			throw new Error("handleFatalRuntimeError should not be reached");
		}) as unknown as (prefix: string, error: unknown) => Promise<never>,
		promptForMissingSessionCwd: vi.fn(async () => "/tmp/override-cwd"),
		createProjectTrustContext: vi.fn(() => ({})),
		cancelResumeWithBudgetError: vi.fn(function (this: ResumeContext, error: ModelUsabilityBudgetError) {
			return cancelResumeWithBudgetError.call(this, error);
		}),
		...overrides,
	};
	return base;
}

describe("InteractiveMode.handleResumeSession budget handling", () => {
	it("cancels and shows the error when the first switch is over budget", async () => {
		const handleResumeSession = getHandleResumeSession();
		const budgetError = makeBudgetError();
		const ctx = makeContext({
			runtimeHost: { switchSession: vi.fn(async () => Promise.reject(budgetError)) },
		});

		const result = await handleResumeSession.call(ctx, "/tmp/session.jsonl");

		expect(result).toEqual({ cancelled: true });
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("Failed to resume session"));
		expect(ctx.handleFatalRuntimeError).not.toHaveBeenCalled();
	});

	it("cancels and shows the error when the cwd-override retry is over budget", async () => {
		const handleResumeSession = getHandleResumeSession();
		const missingCwd = new MissingSessionCwdError({
			sessionFile: "/tmp/session.jsonl",
			sessionCwd: "/tmp/gone",
			fallbackCwd: "/tmp/here",
		});
		const budgetError = makeBudgetError();
		const switchSession = vi
			.fn<(sessionPath: string, options?: unknown) => Promise<{ cancelled: boolean }>>()
			.mockRejectedValueOnce(missingCwd)
			.mockRejectedValueOnce(budgetError);
		const ctx = makeContext({ runtimeHost: { switchSession } });

		const result = await handleResumeSession.call(ctx, "/tmp/session.jsonl");

		expect(result).toEqual({ cancelled: true });
		expect(switchSession).toHaveBeenCalledTimes(2);
		// The second call carried the chosen cwd override.
		expect(switchSession.mock.calls[1]?.[1]).toMatchObject({ cwdOverride: "/tmp/override-cwd" });
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("Failed to resume session"));
		expect(ctx.handleFatalRuntimeError).not.toHaveBeenCalled();
	});
});
