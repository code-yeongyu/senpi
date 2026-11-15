import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import {
	addAccount,
	emptyCredential,
	type AccountSlot,
	type AnthropicSubscriptionCredential,
} from "../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { registerAnthropicSubscriptionExtension } from "../../src/core/extensions/builtin/anthropic-subscription/index.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
} from "../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import type { ExtensionFactory, ProviderConfig } from "../../src/core/extensions/types.ts";
import { subscriptionLimits } from "../../src/core/subscription-limits/limit-store.ts";
import { cliAccountOf, cliLaneEnv, cliSlot } from "./claude-cli-test-slots.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

// senpi#6727: a CLI-owned login with unreadable usage needs a bounded real request on a person's turn.
export const NOW = Date.UTC(2026, 10, 15, 10, 20);
export const RESET = NOW + 5 * 60 * 60_000;
const harnesses: Harness[] = [];

export function blocked(name: string): AccountSlot {
	return cliSlot(name, { blockReason: "rate_limit", blockedAt: NOW - 60_000, blockedUntil: RESET });
}

export function usage(name: string, at: number, usedPercent = 100): void {
	subscriptionLimits.report("anthropic-subscription", name, {
		windows: [{ id: "claude:5h", label: "5h", usedPercent, resetsAt: new Date(RESET).toISOString() }],
		reportedAt: new Date(at),
	});
}

export async function setup(
	accounts: AccountSlot[],
	outcome: (name: string) => string | undefined = () => undefined,
	retry = false,
	extensions: ExtensionFactory[] = [],
) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	let stream: ProviderConfig["streamSimple"];
	const harness = await createHarness({
		provider: "anthropic-subscription",
		models: [{ id: "claude-test", contextWindow: 200_000, maxTokens: 8192 }],
		settings: { retry: { enabled: retry, maxRetries: 1, baseDelayMs: 0 }, compaction: { enabled: false } },
		extensionFactories: [
			...extensions,
			(pi) =>
				registerAnthropicSubscriptionExtension({
					...pi,
					registerProvider: (name, config?: ProviderConfig) => {
						if (typeof name !== "string") return pi.registerProvider(name);
						if (config === undefined) throw new Error("Missing provider config");
						stream = config.streamSimple;
						pi.registerProvider(name, config);
					},
				}),
		],
	});
	harnesses.push(harness);
	const agentDir = join(harness.tempDir, "agent");
	vi.stubEnv("SENPI_CODING_AGENT_DIR", agentDir);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ anthropicSubscriptionProvider: { resumeMode: "off" } }),
	);
	await harness.authStorage.modify("anthropic-subscription", async () =>
		accounts.reduce<AnthropicSubscriptionCredential>(
			(credential, slot) => addAccount(credential, slot),
			emptyCredential(),
		),
	);
	overrideAuthLaneBoundary({
		createStore: () => harness.authStorage,
		env: () => cliLaneEnv(),
		getAgentDir: () => agentDir,
		now: () => NOW,
	});
	const attempts: string[] = [];
	overrideSdkBoundary({
		query: ({ options }) => ({
			async *[Symbol.asyncIterator]() {
				const name = cliAccountOf(options?.env);
				attempts.push(name);
				const failure = outcome(name);
				if (failure !== undefined) throw new Error(failure);
				yield { type: "result", subtype: "success", result: "served" } as SDKMessage;
			},
			async interrupt() {},
			close() {},
		}),
	});
	await harness.session.bindExtensions({});
	harness.agent.streamFunction = (model, context, options) => {
		if (stream === undefined) throw new Error("Claude provider was not registered");
		return stream(model, context, { ...options, cwd: harness.tempDir });
	};
	return { harness, attempts };
}

export async function cleanupClaudeLimitRechecks(): Promise<void> {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	resetSdkBoundary();
	resetAuthLaneBoundary();
	vi.unstubAllEnvs();
	vi.useRealTimers();
}
