import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { RetryFallbackController } from "../src/core/retry-fallback/controller.ts";

function makeModel(provider: string, id: string): Model<Api> {
	return { provider, id } as unknown as Model<Api>;
}

const CLAUDE = makeModel("anthropic", "claude-fable-5");
const KIMI = makeModel("kimi-coding", "kimi-k3");

interface Deps {
	getSettings: () => { modelFallback: boolean; chains: Readonly<Record<string, readonly string[]>> };
	registry: {
		find: (provider: string, id: string) => Model<Api> | undefined;
		getAll: () => Model<Api>[];
		isUsingOAuth?: (model: Model<Api>) => boolean;
		isFallbackEligible?: (model: Model<Api>) => boolean;
	};
	cooldowns: {
		isSuppressed: (selector: string) => boolean;
		note: (selector: string, failure: object) => void;
		clear: (selector: string) => void;
	};
	logger: { info: (event: string, meta: object) => void; debug: (event: string, meta: object) => void };
	switchModel: (model: Model<Api>, thinking: ThinkingLevel, reason: "fallback" | "fallback-revert") => Promise<void>;
	emit: (event: object) => void;
	getCurrentSelector: () => { model: Model<Api>; thinkingLevel?: ThinkingLevel } | undefined;
	isAuthAvailable: (provider: string) => boolean;
}

function makeController(overrides: Partial<Deps> = {}): {
	controller: RetryFallbackController;
	eligibleSpy: ReturnType<typeof vi.fn>;
} {
	const eligibleSpy = vi.fn(() => true);
	const deps: Deps = {
		getSettings: () => ({ modelFallback: true, chains: { "claude-fable-5": ["kimi-k3:max"] } }),
		registry: {
			find: (provider, id) =>
				provider === "anthropic" && id === "claude-fable-5"
					? CLAUDE
					: provider === "kimi-coding" && id === "kimi-k3"
						? KIMI
						: undefined,
			getAll: () => [CLAUDE, KIMI],
			isUsingOAuth: () => false,
			isFallbackEligible: eligibleSpy,
		},
		cooldowns: { isSuppressed: () => false, note: () => {}, clear: () => {} },
		logger: { info: () => {}, debug: () => {} },
		switchModel: vi.fn(async () => {}),
		emit: () => {},
		getCurrentSelector: () => ({ model: CLAUDE, thinkingLevel: undefined }),
		isAuthAvailable: () => true,
		...overrides,
	};
	return { controller: new RetryFallbackController(deps as never), eligibleSpy };
}

describe("RetryFallbackController canonicalization memoization", () => {
	it("#given unchanged settings and registry #when canTryFallback is called repeatedly #then isFallbackEligible is probed once, not per call", () => {
		const { controller, eligibleSpy } = makeController();
		const N = 5;
		for (let i = 0; i < N; i++) controller.canTryFallback();

		expect(eligibleSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
		// Memoized canonicalization probes the registry once, not N times.
		// Current (un-memoized) code re-canonicalizes every call => >= N probes.
		expect(eligibleSpy.mock.calls.length).toBeLessThan(N);
	});

	it("#given a changed chains setting #when canTryFallback runs again #then canonicalization is refreshed", () => {
		let chains: Readonly<Record<string, readonly string[]>> = { "claude-fable-5": ["kimi-k3:max"] };
		const { controller, eligibleSpy } = makeController({ getSettings: () => ({ modelFallback: true, chains }) });
		controller.canTryFallback();
		const before = eligibleSpy.mock.calls.length;

		chains = { "claude-fable-5": ["kimi-k3:max", "claude-opus-5:xhigh"] };
		controller.canTryFallback();

		expect(eligibleSpy.mock.calls.length).toBeGreaterThan(before);
	});
});
