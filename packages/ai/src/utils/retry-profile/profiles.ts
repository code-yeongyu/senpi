import { classifyKimiFailure, classifySenpiAssistantFailure } from "./classifiers.ts";
import type { RetryHintExtractor, RetryPolicyProfile } from "./types.ts";

const extractNormalizedHint: RetryHintExtractor = (failure) => failure.retryAfterMs;

const senpiDefaultTurnStrategy = () => {
	throw new Error("senpi-default turn tier strategy must be injected by coding-agent");
};

export const SENPI_DEFAULT_RETRY_PROFILE: RetryPolicyProfile = {
	id: "senpi-default",
	providerRequest: {
		enabled: true,
		maxRetries: 0,
		backoff: {
			baseDelayMs: 500,
			growthFactor: 2,
			perAttemptCapMs: 8_000,
			jitter: { mode: "subtractive", ratio: 0.25 },
		},
		extractServerHint: extractNormalizedHint,
		serverHint: {
			mode: "override",
			acceptZero: true,
			ceiling: { maxDelayMs: 60_000, onExceeded: "error-with-marker" },
		},
		classify: classifySenpiAssistantFailure,
	},
	turn: {
		enabled: true,
		maxRetries: 3,
		backoff: {
			baseDelayMs: 2_000,
			growthFactor: 2,
			perAttemptCapMs: 8_000,
			jitter: { mode: "additive", ratio: 0.25 },
		},
		extractServerHint: extractNormalizedHint,
		serverHint: {
			mode: "tiered",
			strategy: senpiDefaultTurnStrategy,
		},
		classify: classifySenpiAssistantFailure,
	},
	fallback: {
		terminal: "immediate-if-eligible",
		transient: "after-turn-budget",
		rateLimited: "tiered",
		resetBudgetOnModelChange: true,
	},
};

export const KIMI_CODE_RETRY_PROFILE: RetryPolicyProfile = {
	id: "kimi-code",
	providerRequest: {
		// A user setting retry.provider.maxRetries would otherwise hand Kimi a
		// second hidden retry budget on top of the turn stage's 9.
		enabled: false,
		maxRetries: 0,
		backoff: {
			baseDelayMs: 500,
			growthFactor: 2,
			perAttemptCapMs: 32_000,
			jitter: { mode: "additive", ratio: 0.25 },
		},
		extractServerHint: extractNormalizedHint,
		serverHint: {
			mode: "override",
			acceptZero: false,
			ceiling: { maxDelayMs: null, onExceeded: "error-with-marker" },
		},
		classify: classifyKimiFailure,
	},
	turn: {
		enabled: true,
		maxRetries: 9,
		backoff: {
			baseDelayMs: 500,
			growthFactor: 2,
			perAttemptCapMs: 32_000,
			jitter: { mode: "additive", ratio: 0.25 },
		},
		extractServerHint: extractNormalizedHint,
		serverHint: {
			mode: "override",
			acceptZero: false,
			ceiling: { maxDelayMs: null, onExceeded: "error-with-marker" },
		},
		classify: classifyKimiFailure,
	},
	fallback: {
		terminal: "immediate-if-eligible",
		transient: "after-turn-budget",
		rateLimited: "after-turn-budget",
		resetBudgetOnModelChange: true,
	},
};
