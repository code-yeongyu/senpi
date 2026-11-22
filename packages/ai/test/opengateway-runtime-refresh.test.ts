import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { OPENGATEWAY_MODELS } from "../src/providers/opengateway.models.ts";
import { opengatewayProvider } from "../src/providers/opengateway.ts";
import type { Api, Model } from "../src/types.ts";
import { GATEWAY_URL, gatewayResponse, type ListedModel, PRICES_URL, priceTable } from "./opengateway-fixtures.ts";

const SHIPPED: Model<Api>[] = Object.values(OPENGATEWAY_MODELS);
const SHIPPED_IDS = SHIPPED.map((model) => model.id);
const NEW_MODEL = "anthropic/claude-opus-6";
// Chosen from the shipped catalog so an automated catalog refresh never breaks these tests.
function shippedId(id: string | undefined, role: string): string {
	if (!id) throw new Error(`The shipped OpenGateway catalog has no model usable as the ${role}`);
	return id;
}
const SERVING_TIER_BASE = shippedId(
	SHIPPED.find((model) => model.thinkingLevelMap && model.compat && !SHIPPED_IDS.includes(`${model.id}-ultrafast`))
		?.id,
	"serving-tier base",
);
const NEW_SERVING_TIER = `${SERVING_TIER_BASE}-ultrafast`;
const RETIRED_MODEL = shippedId(
	SHIPPED_IDS.find((id) => id !== SERVING_TIER_BASE),
	"retired model",
);

function listing(extra: ListedModel[]): unknown {
	return gatewayResponse([
		...SHIPPED_IDS.filter((id) => id !== RETIRED_MODEL).map((id) => ({ id })),
		{ id: RETIRED_MODEL, status: "retired" },
		...extra,
	]);
}

const GATEWAY_TODAY = listing([
	{ id: NEW_MODEL, input: ["text", "image"], context_window: 1000000, max_output_tokens: 128000 },
	{ id: NEW_SERVING_TIER, context_window: 200000 },
	{ id: "acme/unpriced-model", context_window: 128000 },
]);
const PRICES_TODAY = priceTable({
	[NEW_MODEL]: { input: 6, output: 30, cacheRead: 0.6 },
	[NEW_SERVING_TIER]: { input: 2.4, output: 12, cacheRead: 0.45 },
});

type Reply = { status: number; body?: unknown };

function serveGateway(models: Reply, prices: Reply = { status: 200, body: PRICES_TODAY }) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input instanceof Request ? input.url : input);
		const reply = url === GATEWAY_URL ? models : url === PRICES_URL ? prices : { status: 404 };
		return new Response(reply.body === undefined ? "unavailable" : JSON.stringify(reply.body), {
			status: reply.status,
			headers: { "content-type": "application/json" },
		});
	});
}

async function configuredRuntime(store = new InMemoryModelsStore()) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("opengateway", async () => ({ type: "api_key", key: "test-key" }));
	const models = createModels({ credentials, modelsStore: store });
	models.setProvider(opengatewayProvider());
	return models;
}

function catalogIds(models: Awaited<ReturnType<typeof configuredRuntime>>): string[] {
	return models.getModels("opengateway").map((model) => model.id);
}

beforeEach(() => {
	vi.stubEnv("OPENGATEWAY_API_KEY", "");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("OpenGateway runtime catalog refresh", () => {
	it("adds a model the gateway newly serves, sized and priced by the gateway", async () => {
		serveGateway({ status: 200, body: GATEWAY_TODAY });
		const models = await configuredRuntime();

		const result = await models.refresh({ providers: ["opengateway"] });

		expect(result.errors).toEqual(new Map());
		expect(models.getModel("opengateway", NEW_MODEL)).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://apis.opengateway.ai/v1",
			input: ["text", "image"],
			contextWindow: 1000000,
			maxTokens: 128000,
			cost: { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 0 },
		});
	});

	it("builds a new serving-tier variant from its shipped base model", async () => {
		serveGateway({ status: 200, body: GATEWAY_TODAY });
		const models = await configuredRuntime();
		const base = models.getModel("opengateway", SERVING_TIER_BASE);
		expect(base?.thinkingLevelMap).toBeDefined();

		await models.refresh({ providers: ["opengateway"] });

		expect(models.getModel("opengateway", NEW_SERVING_TIER)).toMatchObject({
			name: `${base?.name} Ultrafast`,
			reasoning: base?.reasoning,
			thinkingLevelMap: base?.thinkingLevelMap,
			compat: base?.compat,
			contextWindow: 200000,
			cost: { input: 2.4, output: 12, cacheRead: 0.45, cacheWrite: 0 },
		});
	});

	it("leaves out a newly listed model the gateway publishes no price for", async () => {
		serveGateway({ status: 200, body: GATEWAY_TODAY });
		const models = await configuredRuntime();

		await models.refresh({ providers: ["opengateway"] });

		expect(models.getModel("opengateway", "acme/unpriced-model")).toBeUndefined();
	});

	it("removes a model the gateway retired and keeps the rest of the shipped catalog", async () => {
		serveGateway({ status: 200, body: GATEWAY_TODAY });
		const models = await configuredRuntime();
		expect(models.getModel("opengateway", RETIRED_MODEL)).toBeDefined();

		await models.refresh({ providers: ["opengateway"] });

		expect(models.getModel("opengateway", RETIRED_MODEL)).toBeUndefined();
		expect(catalogIds(models)).toEqual(
			expect.arrayContaining(SHIPPED_IDS.filter((id) => id !== RETIRED_MODEL).concat(NEW_MODEL)),
		);
	});

	it("keeps the shipped catalog and reports the failure when the gateway is down", async () => {
		serveGateway({ status: 503 });
		const models = await configuredRuntime();

		const result = await models.refresh({ providers: ["opengateway"] });

		expect(result.errors.get("opengateway")?.message).toMatch(/returned 503/);
		expect(catalogIds(models).sort()).toEqual([...SHIPPED_IDS].sort());
	});

	it("keeps the last refreshed catalog when a later refresh fails", async () => {
		const fetchSpy = serveGateway({ status: 200, body: GATEWAY_TODAY });
		const models = await configuredRuntime();
		await models.refresh({ providers: ["opengateway"] });
		fetchSpy.mockRestore();
		serveGateway({ status: 200, body: GATEWAY_TODAY }, { status: 500 });

		const result = await models.refresh({ providers: ["opengateway"], force: true });

		expect(result.errors.has("opengateway")).toBe(true);
		expect(models.getModel("opengateway", NEW_MODEL)).toBeDefined();
		expect(models.getModel("opengateway", RETIRED_MODEL)).toBeUndefined();
	});

	it("restores the persisted refresh offline in a later session", async () => {
		serveGateway({ status: 200, body: GATEWAY_TODAY });
		const store = new InMemoryModelsStore();
		await (await configuredRuntime(store)).refresh({ providers: ["opengateway"] });
		vi.restoreAllMocks();
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const later = await configuredRuntime(store);
		await later.refresh({ providers: ["opengateway"], allowNetwork: false });

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(later.getModel("opengateway", NEW_MODEL)).toBeDefined();
		expect(later.getModel("opengateway", RETIRED_MODEL)).toBeUndefined();
	});

	it("ignores a persisted refresh taken before the shipped catalog was generated", async () => {
		const store = new InMemoryModelsStore();
		const stale = { ...Object.values(OPENGATEWAY_MODELS)[0], id: "acme/from-an-older-release" };
		await store.write("opengateway", { models: [stale], checkedAt: 0 });
		const models = await configuredRuntime(store);

		await models.refresh({ providers: ["opengateway"], allowNetwork: false });

		expect(models.getModel("opengateway", "acme/from-an-older-release")).toBeUndefined();
		expect(catalogIds(models).sort()).toEqual([...SHIPPED_IDS].sort());
	});

	it("does not contact the gateway when OpenGateway is not configured", async () => {
		const fetchSpy = serveGateway({ status: 200, body: GATEWAY_TODAY });
		const models = createModels({ credentials: new InMemoryCredentialStore() });
		models.setProvider(opengatewayProvider());

		await models.refresh({ providers: ["opengateway"] });

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(models.getModel("opengateway", NEW_MODEL)).toBeUndefined();
	});

	it("removes a shipped model a successful listing no longer includes", async () => {
		const [unlisted, ...rest] = SHIPPED_IDS;
		serveGateway({ status: 200, body: gatewayResponse(rest.map((id) => ({ id }))) });
		const models = await configuredRuntime();

		const result = await models.refresh({ providers: ["opengateway"] });

		expect(result.errors).toEqual(new Map());
		expect(models.getModel("opengateway", unlisted ?? "")).toBeUndefined();
		expect(catalogIds(models).sort()).toEqual([...rest].sort());
	});

	it("does not download the price table when the gateway lists nothing new", async () => {
		const fetchSpy = serveGateway({ status: 200, body: gatewayResponse(SHIPPED_IDS.map((id) => ({ id }))) });
		const models = await configuredRuntime();

		await models.refresh({ providers: ["opengateway"] });

		const urls = fetchSpy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));
		expect(urls).toEqual([GATEWAY_URL]);
	});

	it("caps a newly served GPT model's context to OpenAI's input budget", async () => {
		const gpt = "openai/gpt-6-future";
		serveGateway(
			{ status: 200, body: listing([{ id: gpt, context_window: 1050000, max_output_tokens: 128000 }]) },
			{ status: 200, body: priceTable({ [gpt]: { input: 5, output: 30 } }) },
		);
		const models = await configuredRuntime();

		await models.refresh({ providers: ["opengateway"] });

		expect(models.getModel("opengateway", gpt)).toMatchObject({ contextWindow: 922000, maxTokens: 128000 });
	});

	it("treats an empty gateway listing as an outage and keeps the last good list", async () => {
		serveGateway({ status: 200, body: { object: "list", data: [] } });
		const models = await configuredRuntime();

		const result = await models.refresh({ providers: ["opengateway"] });

		expect(result.errors.get("opengateway")?.message).toMatch(/no models/);
		expect(catalogIds(models).sort()).toEqual([...SHIPPED_IDS].sort());
	});

	it("keeps the last good list when the gateway lists only retired models", async () => {
		serveGateway({ status: 200, body: gatewayResponse(SHIPPED_IDS.map((id) => ({ id, status: "retired" }))) });
		const models = await configuredRuntime();

		const result = await models.refresh({ providers: ["opengateway"] });

		expect(result.errors.get("opengateway")?.message).toMatch(/no servable chat models/);
		expect(catalogIds(models).sort()).toEqual([...SHIPPED_IDS].sort());
	});
});
