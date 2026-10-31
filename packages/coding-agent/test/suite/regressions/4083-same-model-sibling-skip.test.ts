import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	RetryFallbackController,
	type RetryFallbackControllerDeps,
} from "../../../src/core/retry-fallback/controller.ts";
import { SelectorCooldowns } from "../../../src/core/retry-fallback/cooldown.ts";
import type { FallbackReason } from "../../../src/core/retry-fallback/controller-types.ts";

/**
 * senpi#4083: a bare chain entry expands to the same model on two providers. After a failure whose cause
 * lives in the model (a network blip on it, the model overloaded, the model refusing the content), the
 * same model on the other provider fails the same way, so the walk skips it. A failure bound to the route
 * (its account, credentials, rate limit, or a server error) leaves the sibling a real second chance.
 */
const base = getModel("openai", "gpt-5.4");
const model = (provider: string, id: string): Model<Api> => ({ ...base, provider, id });

const primary = model("route-a", "big-model");
const sameOnA = model("route-a", "mid-model");
const sameOnB = model("route-b", "mid-model");
// A provider-side namespace (e.g. Bedrock's `global.vendor.<id>`) names the same model.
const sameOnC = model("route-c", "global.vendor.mid-model");
const otherModel = model("route-d", "other-model");

function createController(
	chain: readonly string[],
	models: Model<Api>[],
	isAuthAvailable: (provider: string) => boolean = () => true,
) {
	const switches: string[] = [];
	const skips: { candidate: string; skipReason: string }[] = [];
	let current: { model: Model<Api>; thinkingLevel?: ThinkingLevel } = { model: primary, thinkingLevel: "high" };
	const deps: RetryFallbackControllerDeps = {
		getSettings: () => ({ modelFallback: true, chains: { "route-a/big-model": chain } }),
		registry: {
			find: (provider, id) => models.find((entry) => entry.provider === provider && entry.id === id),
			getAll: () => models,
		},
		cooldowns: new SelectorCooldowns(() => 0),
		logger: {
			debug: (event, data) => {
				if (event === "candidate_skipped") skips.push(data as { candidate: string; skipReason: string });
			},
			info: () => {},
			warn: () => {},
		},
		switchModel: async (next, thinking) => {
			switches.push(`${next.provider}/${next.id}`);
			current = { model: next, thinkingLevel: thinking };
		},
		emit: () => {},
		getCurrentSelector: () => current,
		isAuthAvailable,
	};
	return { controller: new RetryFallbackController(deps), switches, skips };
}

interface Row {
	name: string;
	reason: FallbackReason;
	errorMessage?: string;
	next: string;
}

const MODEL_SHARED: Row[] = [
	{ name: "connection error", reason: "transient", errorMessage: "Connection error.", next: "route-d/other-model" },
	{
		name: "socket reset",
		reason: "transient",
		errorMessage: "TypeError: fetch failed (ECONNRESET)",
		next: "route-d/other-model",
	},
	{
		name: "model overloaded",
		reason: "transient",
		errorMessage: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
		next: "route-d/other-model",
	},
	{ name: "content refusal", reason: "refusal", next: "route-d/other-model" },
];

const ROUTE_BOUND: Row[] = [
	{
		name: "account usage limit",
		reason: "transient",
		errorMessage: "You've hit your session limit · resets 3pm",
		next: "route-b/mid-model",
	},
	{
		name: "billing",
		reason: "billing",
		errorMessage: "Your credit balance is too low to access the API",
		next: "route-b/mid-model",
	},
	{
		name: "auth rejected",
		reason: "hard-error",
		errorMessage: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
		next: "route-b/mid-model",
	},
	{
		name: "rate limit",
		reason: "transient",
		errorMessage: "429 Too Many Requests: rate limit reached",
		next: "route-b/mid-model",
	},
	{ name: "server error", reason: "transient", errorMessage: "500 Internal Server Error", next: "route-b/mid-model" },
	{
		name: "rate limit that also timed out",
		reason: "transient",
		errorMessage: "429 Too Many Requests: rate limit reached, request timed out",
		next: "route-b/mid-model",
	},
];

async function walkTo(row: Row, chain: readonly string[], models: Model<Api>[]) {
	const harness = createController(chain, models);
	expect(await harness.controller.tryFallback("hard-error", { errorMessage: "400 invalid request" })).toBe(true);
	expect(harness.switches).toEqual(["route-a/mid-model"]);
	const moved = await harness.controller.tryFallback(
		row.reason,
		row.errorMessage === undefined ? {} : { errorMessage: row.errorMessage },
	);
	return { moved, ...harness };
}

describe("senpi#4083 same-model sibling of a bare chain entry", () => {
	const chain = ["mid-model", "route-d/other-model"];
	const models = [primary, sameOnA, sameOnB, otherModel];

	it("expands the bare entry to the same model on two routes", async () => {
		const { switches } = await walkTo(ROUTE_BOUND[0] as Row, chain, models);
		expect(switches).toEqual(["route-a/mid-model", "route-b/mid-model"]);
	});

	for (const row of MODEL_SHARED) {
		it(`#given a ${row.name} on the model #then the same model on another route is skipped`, async () => {
			const { moved, switches, skips } = await walkTo(row, chain, models);
			expect(moved).toBe(true);
			expect(switches.at(-1)).toBe(row.next);
			expect(skips).toContainEqual({ candidate: "route-b/mid-model", skipReason: "same-model" });
		});
	}

	for (const row of ROUTE_BOUND) {
		it(`#given a ${row.name} on the route #then the same model on another route is still tried`, async () => {
			const { moved, switches } = await walkTo(row, chain, models);
			expect(moved).toBe(true);
			expect(switches.at(-1)).toBe(row.next);
		});
	}

	it("#given a namespaced id for the same model #when the model blips #then that sibling is skipped too", async () => {
		const { switches } = await walkTo(
			MODEL_SHARED[0] as Row,
			["route-a/mid-model", "route-c/global.vendor.mid-model", "route-d/other-model"],
			[primary, sameOnA, sameOnC, otherModel],
		);
		expect(switches.at(-1)).toBe("route-d/other-model");
	});

	it("#given only same-model siblings remain #when the model blips #then the chain is exhausted for this walk", async () => {
		const { moved, switches } = await walkTo(MODEL_SHARED[0] as Row, ["mid-model"], [primary, sameOnA, sameOnB]);
		expect(moved).toBe(false);
		expect(switches).toEqual(["route-a/mid-model"]);
	});

	it("#given a blip skipped the sibling #when a later route-bound failure walks again #then the sibling is offered", async () => {
		const harness = createController(
			["mid-model", "route-d/other-model"],
			models,
			(provider) => provider !== "route-d",
		);
		await harness.controller.tryFallback("hard-error", { errorMessage: "400 invalid request" });
		expect(await harness.controller.tryFallback("transient", { errorMessage: "Connection error." })).toBe(false);
		expect(harness.switches).toEqual(["route-a/mid-model"]);
		harness.controller.resetTurn();
		expect(
			await harness.controller.tryFallback("transient", {
				errorMessage: "You've hit your session limit · resets 3pm",
			}),
		).toBe(true);
		expect(harness.switches.at(-1)).toBe("route-b/mid-model");
	});
});
