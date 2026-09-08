import { describe, expect, it, vi } from "vitest";
import { type AgentSessionRuntime, SessionResumePreparationError } from "../../src/core/agent-session-runtime.ts";
import { ModelUsabilityBudgetError } from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import type { ExtensionCommandContext, ProjectTrustContext } from "../../src/core/extensions/index.ts";
import { MissingSessionCwdError } from "../../src/core/session-cwd.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";

type ResumeContext = {
	clearStatusIndicator: () => void;
	runtimeHost: Pick<AgentSessionRuntime, "switchSession">;
	createProjectTrustContext: (cwd: string) => ProjectTrustContext;
	promptForMissingSessionCwd: (error: MissingSessionCwdError) => Promise<string | undefined>;
	showError: (message: string) => void;
	showStatus: (message: string) => void;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
};

const handleResumeSession = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "handleResumeSession")!
	.value as (
	this: ResumeContext,
	sessionPath: string,
	options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
) => Promise<{ cancelled: boolean }>;

function createContext() {
	return {
		clearStatusIndicator: vi.fn(),
		runtimeHost: { switchSession: vi.fn<AgentSessionRuntime["switchSession"]>() },
		createProjectTrustContext: vi.fn<ResumeContext["createProjectTrustContext"]>(),
		promptForMissingSessionCwd: vi.fn<ResumeContext["promptForMissingSessionCwd"]>(),
		showError: vi.fn(),
		showStatus: vi.fn(),
		handleFatalRuntimeError: vi.fn<ResumeContext["handleFatalRuntimeError"]>(async (_prefix, error) => {
			throw error;
		}),
	};
}

function budgetError() {
	return new ModelUsabilityBudgetError({
		model: "test/model",
		contextWindow: 600_000,
		liveContextTokens: 600_585,
		systemPromptTokens: 2_000,
		activeToolSchemaTokens: 1_000,
		outputReserveTokens: 16_000,
		compactionReserveTokens: 0,
		speculationLeadTokens: 0,
		safetyMarginTokens: 8_192,
		safetyMarginProfile: "default",
		requiredTokens: 627_777,
		shortfallTokens: 27_777,
		usable: false,
		admission: "resume",
	});
}

const missingCwd = new MissingSessionCwdError({
	sessionFile: "/saved.jsonl",
	sessionCwd: "/missing",
	fallbackCwd: "/current",
});

describe("interactive resume preparation failures", () => {
	it.each([false, true])("shows a nonfatal, actionable budget error (cwd retry: %s)", async (retryCwd) => {
		const context = createContext();
		const error = new SessionResumePreparationError(budgetError());
		if (retryCwd) {
			context.runtimeHost.switchSession.mockRejectedValueOnce(missingCwd);
			context.promptForMissingSessionCwd.mockResolvedValue("/current");
		}
		context.runtimeHost.switchSession.mockRejectedValueOnce(error);

		await expect(handleResumeSession.call(context, "/saved.jsonl")).resolves.toEqual({ cancelled: true });

		expect(context.showError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(error.message));
		expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("Your current session is still active"));
		expect(context.showError).toHaveBeenCalledWith(
			expect.stringContaining("--session <path> --model <larger-context-model>"),
		);
		expect(context.showStatus).not.toHaveBeenCalled();
		expect(context.handleFatalRuntimeError).not.toHaveBeenCalled();
		expect(context.runtimeHost.switchSession).toHaveBeenCalledTimes(retryCwd ? 2 : 1);
	});

	it("keeps generic target setup failures nonfatal", async () => {
		const context = createContext();
		context.runtimeHost.switchSession.mockRejectedValue(new SessionResumePreparationError(new Error("setup failed")));
		await expect(handleResumeSession.call(context, "/saved.jsonl")).resolves.toEqual({ cancelled: true });
		expect(context.showError).toHaveBeenCalledWith(
			expect.stringContaining("Fix the target session's setup and retry"),
		);
		expect(context.handleFatalRuntimeError).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"does not misclassify failures after preparation as safe (cwd retry: %s)",
		async (retryCwd) => {
			const context = createContext();
			if (retryCwd) {
				context.runtimeHost.switchSession.mockRejectedValueOnce(missingCwd);
				context.promptForMissingSessionCwd.mockResolvedValue("/current");
			}
			const error = new Error("rebind failed");
			context.runtimeHost.switchSession.mockRejectedValueOnce(error);
			await expect(handleResumeSession.call(context, "/saved.jsonl")).rejects.toBe(error);
			expect(context.handleFatalRuntimeError).toHaveBeenCalledExactlyOnceWith("Failed to resume session", error);
			expect(context.showError).not.toHaveBeenCalled();
		},
	);

	it.each([false, true])("preserves success feedback and withSession (cwd retry: %s)", async (retryCwd) => {
		const context = createContext();
		const withSession = vi.fn();
		if (retryCwd) {
			context.runtimeHost.switchSession.mockRejectedValueOnce(missingCwd);
			context.promptForMissingSessionCwd.mockResolvedValue("/current");
		}
		context.runtimeHost.switchSession.mockResolvedValueOnce({ cancelled: false });
		await expect(handleResumeSession.call(context, "/saved.jsonl", { withSession })).resolves.toEqual({
			cancelled: false,
		});
		expect(context.runtimeHost.switchSession).toHaveBeenLastCalledWith(
			"/saved.jsonl",
			expect.objectContaining({ withSession }),
		);
		expect(context.showStatus).toHaveBeenCalledExactlyOnceWith(
			retryCwd ? "Resumed session in current cwd" : "Resumed session",
		);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("preserves extension cancellation", async () => {
		const context = createContext();
		context.runtimeHost.switchSession.mockResolvedValue({ cancelled: true });
		await expect(handleResumeSession.call(context, "/saved.jsonl")).resolves.toEqual({ cancelled: true });
		expect(context.showStatus).not.toHaveBeenCalled();
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("cancels without a second switch if the cwd prompt is declined", async () => {
		const context = createContext();
		context.runtimeHost.switchSession.mockRejectedValueOnce(missingCwd);
		context.promptForMissingSessionCwd.mockResolvedValue(undefined);
		await expect(handleResumeSession.call(context, "/saved.jsonl")).resolves.toEqual({ cancelled: true });
		expect(context.runtimeHost.switchSession).toHaveBeenCalledTimes(1);
		expect(context.showStatus).toHaveBeenCalledExactlyOnceWith("Resume cancelled");
		expect(context.handleFatalRuntimeError).not.toHaveBeenCalled();
	});
});
