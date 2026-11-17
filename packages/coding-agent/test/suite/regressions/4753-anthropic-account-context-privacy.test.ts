// Desktop#4753: logs retain the seat-digest invariant while the owner-facing error can name the account.
import { afterEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../../../src/config.ts";
import {
	attemptAccountContext,
	logAttemptAccount,
	rememberAccountContext,
} from "../../../src/core/extensions/builtin/anthropic-subscription/account-context.ts";
import type { AuthenticatedAttemptInput } from "../../../src/core/extensions/builtin/anthropic-subscription/auth-attempt.ts";
import {
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-observability.ts";
import { withAuthGuidance } from "../../../src/core/extensions/builtin/anthropic-subscription/stream-guidance.ts";
import { cliSlot } from "../../support/claude-cli-test-slots.ts";

const attempt: AuthenticatedAttemptInput = {
	accountName: "john-smith",
	accounts: [cliSlot("john-smith")],
	authLane: "claude-cli",
	options: {},
};

afterEach(resetContinuityObservabilityBoundary);

describe("billing account privacy and composed guidance", () => {
	it("writes salted seat/directory digests but no account name or absolute path", () => {
		const logged: Array<Record<string, unknown>> = [];
		overrideContinuityObservabilityBoundary({ log: (_event, fields) => logged.push(fields) });
		logAttemptAccount(attempt, "synthetic-session");
		expect(logged).toEqual([
			{
				sessionId: "synthetic-session",
				agentDir: expect.stringMatching(/^dir:[0-9a-f]{8}$/),
				agentDirSource: expect.any(String),
				agentDirRule: expect.stringMatching(/^(environment|home-default|project-local)$/),
				seat: expect.stringMatching(/^[0-9a-f]{8}$/),
				accountSource: "login",
			},
		]);
		const serialized = JSON.stringify(logged);
		expect(serialized).not.toContain(attempt.accountName);
		expect(serialized).not.toContain(getAgentDir());
		expect(serialized).not.toContain("synthetic-access");
		expect(serialized).not.toContain("synthetic-refresh");
	});

	it("does not identify a missing managed slot as ambient authentication", () => {
		expect(attemptAccountContext({ ...attempt, accounts: [] }).accountSource).toBe("unknown");
		expect(
			attemptAccountContext({
				accountName: "ambient",
				accounts: [],
				authLane: "ambient",
				options: {},
			}).accountSource,
		).toBe("ambient");
	});

	it("preserves the executable-version action beside an attributed billing refusal", () => {
		const error = new Error("You're out of extra usage. claude_code_version_too_old");
		rememberAccountContext(error, attemptAccountContext(attempt));
		const shown = withAuthGuidance(error, error.message, { source: "path", executable: "claude" });
		expect(shown).toContain(attempt.accountName);
		expect(shown).toContain("/claude-account pin");
		expect(shown).toContain("claude update");
	});
});
