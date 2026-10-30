import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import { createFallbackCircuitAccess, FallbackCircuitBreaker } from "../../../src/core/retry-fallback/circuit.ts";
import {
	RetryFallbackController,
	type RetryFallbackControllerDeps,
} from "../../../src/core/retry-fallback/controller.ts";
import { SelectorCooldowns } from "../../../src/core/retry-fallback/cooldown.ts";
import { emitProviderAccountsChanged } from "../../../src/core/extensions/builtin/anthropic-subscription/account-events.ts";
import { followProviderAccountChanges } from "../../../src/core/retry-fallback/controller.ts";

const MINUTE = 60_000;
const primary = "openai-codex/gpt-5.6-sol";
const fallback = "anthropic/claude-opus-5-5";
// An account-wide usage limit whose reset the provider named itself (senpi#3347).
const usageLimit = {
	errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~120 min.",
	retryAfterMs: 120 * MINUTE,
};

function model(selector: string): Model<Api> {
	const [provider = "", id = ""] = selector.split("/");
	return { ...getModel("anthropic", "claude-opus-4-5"), provider, id };
}

function harness() {
	const models = [model(primary), model(fallback)];
	let now = Date.parse("2026-10-14T10:00:00Z");
	let current: { model: Model<Api> } = { model: models[0] as Model<Api> };
	const logger = { debug: () => {}, info: () => {}, warn: () => {} };
	const deps: RetryFallbackControllerDeps = {
		getSettings: () => ({ modelFallback: true, chains: { [primary]: [fallback] } }),
		registry: {
			find: (provider, id) => models.find((entry) => entry.provider === provider && entry.id === id),
			getAll: () => models,
		},
		cooldowns: new SelectorCooldowns(() => now),
		// The session wires the process-wide breaker with its shipped 30-minute ceiling.
		circuits: createFallbackCircuitAccess({
			breaker: new FallbackCircuitBreaker(),
			owner: () => "session",
			now: () => now,
			settings: () => ({ cooldownMs: MINUTE, maxCooldownMs: 30 * MINUTE }),
			logger,
		}),
		logger,
		switchModel: async (next) => {
			current = { model: next };
		},
		emit: () => {},
		getCurrentSelector: () => current,
		isAuthAvailable: () => true,
	};
	return {
		controller: new RetryFallbackController(deps),
		selector: () => `${current.model.provider}/${current.model.id}`,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("retry fallback: restoring the primary honours its account hold (senpi#3347)", () => {
	it("keeps session A's hold when session B persists a block on another slot", async () => {
		const { controller, selector, advance } = harness();
		const directory = mkdtempSync(join(tmpdir(), "3347-sibling-block-"));
		const repository = new CredentialSlotRepository(join(directory, "health.json"));
		const unfollow = followProviderAccountChanges(controller);
		try {
			await controller.tryFallback("transient", usageLimit);
			controller.resetTurn();
			// Session B's real pool write publishes through the process-global event bus.
			const siblingStream = streamWithCredentialRotation({
				sources: {
					providerId: "openai-codex",
					credential: {
						type: "api_key",
						key: "synthetic-key",
						accounts: [{ name: "session-b", key: "synthetic-key", source: "login" }],
					},
					env: () => undefined,
					repository,
					now: () => Date.parse("2026-10-14T10:00:00Z"),
				},
				affinityKey: "session-b",
				runAttempt: async function* () {
					throw new Error("429 rate limited");
				},
			});
			await expect(
				(async () => {
					for await (const _event of siblingStream) {
						// Exhaust the generator so the block write and notice have committed.
					}
				})(),
			).rejects.toThrow("429 rate limited");
			expect((await repository.listSlots("openai-codex", "stored"))["session-b"]?.blockReason).toBe(
				"rate_limit",
			);
			advance(31 * MINUTE);
			expect(await controller.maybeRestorePrimary("cooldown-expiry")).toBe(false);
			expect(selector()).toBe(fallback);
		} finally {
			unfollow();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps the fallback while the primary's named usage-limit reset is still ahead", async () => {
		const { controller, selector, advance } = harness();

		await controller.tryFallback("transient", usageLimit);
		expect(selector()).toBe(fallback);
		controller.resetTurn();
		advance(31 * MINUTE);

		expect(await controller.maybeRestorePrimary("cooldown-expiry")).toBe(false);
		expect(selector()).toBe(fallback);
	});

	it("restores the primary once the hold it named has passed", async () => {
		const { controller, selector, advance } = harness();

		await controller.tryFallback("transient", usageLimit);
		controller.resetTurn();
		advance(121 * MINUTE);

		expect(await controller.maybeRestorePrimary("cooldown-expiry")).toBe(true);
		expect(selector()).toBe(primary);
	});

	it("drops the hold when the primary's provider accounts change (a login or an added account)", async () => {
		const { controller, selector, advance } = harness();
		const unfollow = followProviderAccountChanges(controller);
		try {
			await controller.tryFallback("transient", usageLimit);
			controller.resetTurn();
			emitProviderAccountsChanged("openai-codex");
			advance(31 * MINUTE);

			expect(await controller.maybeRestorePrimary("cooldown-expiry")).toBe(true);
			expect(selector()).toBe(primary);
		} finally {
			unfollow();
		}
	});

	it("keeps the hold when another provider's accounts change", async () => {
		const { controller, selector, advance } = harness();
		const unfollow = followProviderAccountChanges(controller);
		try {
			await controller.tryFallback("transient", usageLimit);
			controller.resetTurn();
			emitProviderAccountsChanged("anthropic");
			advance(31 * MINUTE);

			expect(await controller.maybeRestorePrimary("cooldown-expiry")).toBe(false);
			expect(selector()).toBe(fallback);
		} finally {
			unfollow();
		}
	});
});
