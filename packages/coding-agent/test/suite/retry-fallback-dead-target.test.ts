import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { RetryFallbackController, type RetryFallbackControllerDeps } from "../../src/core/retry-fallback/controller.ts";
import { SelectorCooldowns } from "../../src/core/retry-fallback/cooldown.ts";

function model(provider: string, id: string): Model<Api> {
	return { ...getModel("anthropic", "claude-opus-4-5"), provider, id };
}

const forbidden = { errorMessage: '{"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}' };
const creditBalance = {
	errorMessage:
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
};

const original = "anthropic/claude-opus-5-5";
// The shipped claude-opus-5-5 ladder after two-provider bare expansion (senpi#2376 incident trail).
const expandedLadder = [
	"anthropic/claude-opus-5",
	"anthropic-api/claude-opus-5",
	"anthropic/claude-opus-4-8",
	"anthropic-api/claude-opus-4-8",
	"anthropic/claude-opus-4-6",
	"anthropic-api/claude-opus-4-6",
];

function createController(chain: readonly string[], start = original) {
	const models = [start, ...chain].map((selector) => {
		const [provider = "", id = ""] = selector.split("/");
		return model(provider, id);
	});
	let now = 0;
	let current: { model: Model<Api> } = { model: models[0] ?? model("anthropic", "claude-opus-5-5") };
	const events: unknown[] = [];
	const deps: RetryFallbackControllerDeps = {
		getSettings: () => ({ modelFallback: true, chains: { [start]: chain } }),
		registry: {
			find: (provider, id) => models.find((entry) => entry.provider === provider && entry.id === id),
			getAll: () => models,
		},
		cooldowns: new SelectorCooldowns(() => now),
		logger: { debug: () => {}, info: () => {}, warn: () => {} },
		switchModel: async (next) => {
			current = { model: next };
		},
		emit: (event) => events.push(event),
		getCurrentSelector: () => current,
		isAuthAvailable: () => true,
	};
	return {
		controller: new RetryFallbackController(deps),
		events,
		selector: () => `${current.model.provider}/${current.model.id}`,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("retry fallback: billing-dead fallback targets (senpi#2376)", () => {
	it("skips the remaining rungs of a provider whose account answered with a billing error", async () => {
		const { controller, selector } = createController(expandedLadder);

		const walk: string[] = [];
		for (const failure of [forbidden, forbidden, creditBalance, forbidden]) {
			await controller.tryFallback(failure === creditBalance ? "billing" : "transient", failure);
			walk.push(selector());
		}

		expect(walk).toEqual([
			"anthropic/claude-opus-5",
			"anthropic-api/claude-opus-5",
			"anthropic/claude-opus-4-8",
			"anthropic/claude-opus-4-6",
		]);
	});

	it("does not pin the episode when only a fallback target hit billing", async () => {
		const { controller } = createController(expandedLadder);

		await controller.tryFallback("transient", forbidden);
		await controller.tryFallback("transient", forbidden);
		await controller.tryFallback("billing", creditBalance);

		expect(controller.activeState?.pinned).toBe(false);
	});

	it("still pins when the original model itself hit billing", async () => {
		const { controller } = createController(expandedLadder);

		await controller.tryFallback("billing", creditBalance);

		expect(controller.activeState?.pinned).toBe(true);
	});

	it("returns to the original at the turn boundary when the chain ended on a billing-dead target", async () => {
		const { controller, events, selector, advance } = createController(["anthropic-api/claude-opus-5"]);

		await controller.tryFallback("transient", forbidden);
		controller.noteHealthFailure(model("anthropic-api", "claude-opus-5"), undefined, creditBalance);
		controller.resetTurn();
		advance(1_000);

		const restored = await controller.maybeRestorePrimary("cooldown-expiry");

		expect({ restored, model: selector(), state: controller.activeState, events: events.slice(1) }).toEqual({
			restored: true,
			model: original,
			state: undefined,
			events: [
				{
					type: "retry_fallback_reverted",
					from: "anthropic-api/claude-opus-5",
					to: original,
					cause: "fallback-unusable",
				},
			],
		});
	});

	it("returns from a billing-dead target even under the never-revert policy", async () => {
		const { controller, selector } = createController(["anthropic-api/claude-opus-5"]);

		await controller.tryFallback("transient", forbidden);
		controller.noteHealthFailure(model("anthropic-api", "claude-opus-5"), undefined, creditBalance);

		expect(await controller.maybeRestorePrimary("never")).toBe(true);
		expect(selector()).toBe(original);
	});

	it("does not return into an original whose own account is billing-dead", async () => {
		const { controller, selector } = createController(["anthropic/claude-opus-5"]);

		await controller.tryFallback("transient", forbidden);
		controller.noteHealthFailure(model("anthropic", "claude-opus-5"), undefined, creditBalance);

		expect(await controller.maybeRestorePrimary("cooldown-expiry")).toBe(false);
		expect(selector()).toBe("anthropic/claude-opus-5");
	});

	it("keeps a healthy transient fallback in place while the original is still cooling down", async () => {
		const { controller, selector, advance } = createController(["anthropic-api/claude-opus-5"]);

		await controller.tryFallback("transient", forbidden);
		advance(1_000);

		expect(await controller.maybeRestorePrimary("cooldown-expiry")).toBe(false);
		expect(selector()).toBe("anthropic-api/claude-opus-5");
	});
});
