import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptOptions } from "../../../src/core/agent-session.ts";
import {
	addAccount,
	emptyCredential,
	type AccountSlot,
	type AnthropicSubscriptionCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { registerAnthropicSubscriptionExtension } from "../../../src/core/extensions/builtin/anthropic-subscription/index.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import type { ProviderConfig } from "../../../src/core/extensions/types.ts";
import { subscriptionLimits } from "../../../src/core/subscription-limits/limit-store.ts";
import { cliAccountOf, cliLaneEnv, cliSlot } from "../../support/claude-cli-test-slots.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#6727: a CLI-owned login with unreadable usage needs a bounded real request on a person's turn.
const NOW = Date.UTC(2026, 10, 15, 10, 20);
const RESET = NOW + 5 * 60 * 60_000;
const harnesses: Harness[] = [];

function blocked(name: string): AccountSlot {
	return cliSlot(name, { blockReason: "rate_limit", blockedAt: NOW - 60_000, blockedUntil: RESET });
}

function usage(name: string, at: number, usedPercent = 100): void {
	subscriptionLimits.report("anthropic-subscription", name, {
		windows: [{ id: "claude:5h", label: "5h", usedPercent, resetsAt: new Date(RESET).toISOString() }],
		reportedAt: new Date(at),
	});
}

async function setup(
	accounts: AccountSlot[],
	outcome: (name: string) => string | undefined = () => undefined,
	retry = false,
) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	let stream: ProviderConfig["streamSimple"];
	const harness = await createHarness({
		provider: "anthropic-subscription",
		models: [{ id: "claude-test", contextWindow: 200_000, maxTokens: 8192 }],
		settings: { retry: { enabled: retry, maxRetries: 1, baseDelayMs: 0 }, compaction: { enabled: false } },
		extensionFactories: [
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

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	resetSdkBoundary();
	resetAuthLaneBoundary();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("person-started stale Claude block rechecks (senpi#6727)", () => {
	it("uses a healthy account without probing a stale-blocked pin on a person's turn", async () => {
		usage("healthy-first", NOW, 0);
		const { harness, attempts } = await setup([blocked("stale-pin"), cliSlot("healthy-first")], (name) =>
			name === "stale-pin" ? "You've hit your limit · resets in 2 hours" : undefined,
		);
		await harness.authStorage.modify("anthropic-subscription", async (current) => {
			if (current?.type !== "oauth") throw new Error("Missing Claude credential");
			return { ...current, pinned: "stale-pin" };
		});

		await harness.session.prompt("use the available account");

		expect(attempts).toEqual(["healthy-first"]);
		expect(harness.session.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "served" }] });
	});

	it("serves a blocked account with no fresh usage and clears its stored block", async () => {
		const { harness, attempts } = await setup([blocked("stale-free")]);
		await harness.session.prompt("try now");
		expect(attempts).toEqual(["stale-free"]);
		expect(harness.session.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "served" }] });
		expect(harness.authStorage.get("anthropic-subscription")).toMatchObject({
			accounts: [expect.not.objectContaining({ blockReason: "rate_limit" })],
		});
	});

	it.each([
		{ source: "extension" },
		{ source: "rpc" },
		{ source: "rpc", interactiveUser: false },
	] satisfies PromptOptions[])("sends nothing for automated input %j", async (options) => {
		const { harness, attempts } = await setup([blocked("auto-spent")]);
		await harness.session.prompt("continue", options);
		expect(attempts).toEqual([]);
	});

	it("accepts interactive RPC attribution and skips a spent account for a free sibling", async () => {
		const { harness, attempts } = await setup([blocked("rpc-spent"), blocked("rpc-free")], (name) =>
			name === "rpc-spent" ? "You've hit your limit · resets in 2 hours" : undefined,
		);
		await harness.authStorage.modify("anthropic-subscription", async (current) => {
			if (current?.type !== "oauth") throw new Error("Missing Claude credential");
			return { ...current, pinned: "rpc-spent" };
		});
		await harness.session.prompt("try now", { source: "rpc", interactiveUser: true });
		expect(attempts).toEqual(["rpc-spent", "rpc-free"]);
		expect(harness.session.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "served" }] });
	});

	it("trusts usage reported after the block, but rechecks a failed usage read", async () => {
		usage("fresh-spent", NOW);
		subscriptionLimits.report("anthropic-subscription", "fresh-spent", {
			error: "unreachable",
			reportedAt: new Date(NOW + 1),
		});
		subscriptionLimits.report("anthropic-subscription", "unreadable-free", {
			error: "auth stale - run /login",
			reportedAt: new Date(NOW),
		});
		const { harness, attempts } = await setup([blocked("fresh-spent"), blocked("unreadable-free")]);
		await harness.session.prompt("try now");
		expect(attempts).toEqual(["unreadable-free"]);
	});

	it("reblocks a spent account with its fresh reset and grants only the next person's turn another check", async () => {
		const { harness, attempts } = await setup(
			[blocked("still-spent")],
			() => "You've hit your limit · resets in 2 hours",
		);
		await harness.session.prompt("try now");
		expect(attempts).toEqual(["still-spent"]);
		expect(harness.authStorage.get("anthropic-subscription")).toMatchObject({
			accounts: [expect.objectContaining({ blockedAt: NOW, blockedUntil: NOW + 2 * 60 * 60_000 })],
		});
		await expect(harness.session.prompt("automated continuation", { source: "extension" })).rejects.toMatchObject({
			name: "AccountUsageLimitError",
		});
		expect(attempts).toEqual(["still-spent"]);
		await harness.session.prompt("try again");
		expect(attempts).toEqual(["still-spent", "still-spent"]);
	});

	it("does not retry a half-open request after a transient failure", async () => {
		const { harness, attempts } = await setup([blocked("unreachable")], () => "overloaded_error", true);
		await harness.session.prompt("try now");
		expect(attempts).toEqual(["unreachable"]);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.authStorage.get("anthropic-subscription")).toMatchObject({
			accounts: [expect.objectContaining({ blockedUntil: RESET, blockReason: "rate_limit" })],
		});
	});

	it("preserves model blocks and non-limit blocks on a person's turn", async () => {
		const { harness, attempts } = await setup([
			{ ...blocked("model-spent"), modelBlocks: { "claude-test": { blockedUntil: RESET } } },
			{ ...blocked("billing"), blockReason: "billing" },
			cliSlot("signed-out", { signInRequired: "login_expired" }),
		]);
		await harness.session.prompt("try now");
		expect(attempts).toEqual([]);
	});

	it("keeps account fallback disabled even when a blocked sibling could serve", async () => {
		const { harness, attempts } = await setup(
			[blocked("pinned-spent"), blocked("unused-free")],
			() => "You've hit your limit · resets in 2 hours",
		);
		writeFileSync(
			join(harness.tempDir, "agent", "settings.json"),
			JSON.stringify({
				anthropicSubscriptionProvider: {
					resumeMode: "off",
					accountFallback: false,
					pinnedAccount: "pinned-spent",
				},
			}),
		);
		await harness.session.prompt("try now");
		expect(attempts).toEqual(["pinned-spent"]);
	});
});
