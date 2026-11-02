import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	defaultModelPerProvider,
	findInitialModel,
	restoreModelFromSession,
} from "../../../src/core/model-resolver.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { allowNetwork } from "../../test-network-env.ts";

// Regression for https://github.com/code-yeongyu/senpi/issues/2552: once the OpenGateway catalog
// refreshes itself, a model the gateway retires disappears; a saved selection of it must fall back
// to a working model instead of breaking startup or session restore.

const OPENGATEWAY_DEFAULT = defaultModelPerProvider.opengateway;
// Any shipped model other than the provider default, so a catalog refresh never invalidates the test.
const RETIRED = getBuiltinModels("opengateway").find((model) => model.id !== OPENGATEWAY_DEFAULT)?.id ?? "";

function gatewayListing(): unknown {
	return {
		object: "list",
		data: getBuiltinModels("opengateway").map((model) => ({
			id: model.id,
			object: "model",
			status: model.id === RETIRED ? "retired" : "active",
			modalities: { input: model.input, output: ["text"] },
			endpoints: ["chat_completions"],
			providers: [{ id: "primary", region: "global" }],
		})),
	};
}

const PRICE_TABLE = {
	"primary/unrelated": {
		provider: "primary",
		modelOwner: "acme",
		modelName: "unrelated",
		pricing: { current: { effectivePrice: { inputCostPerToken: 1e-6, outputCostPerToken: 1e-6 } } },
	},
};

async function refreshedRuntime(): Promise<ModelRuntime> {
	allowNetwork();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input instanceof Request ? input.url : input);
		const body = url.startsWith("https://apis.opengateway.ai/v1/models")
			? gatewayListing()
			: url.startsWith("https://opengateway.ai/api/model-prices")
				? PRICE_TABLE
				: undefined;
		return body === undefined ? new Response("not found", { status: 404 }) : Response.json(body);
	});
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("opengateway", async () => ({ type: "api_key", key: "test-key" }));
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		allowModelNetwork: true,
		refreshOnCreate: false,
		modelRefreshTimeoutMs: 5_000,
	});
	const result = await runtime.refresh({ allowNetwork: true });
	expect(result.errors.get("opengateway")).toBeUndefined();
	return runtime;
}

afterEach(() => vi.restoreAllMocks());

describe("OpenGateway retired model in a saved selection (#2552)", () => {
	it("removes the retired model from the refreshed catalog", async () => {
		const runtime = await refreshedRuntime();

		expect(runtime.getModel("opengateway", RETIRED)).toBeUndefined();
		expect(runtime.getModel("opengateway", OPENGATEWAY_DEFAULT)).toBeDefined();
	});

	it("restores a session that used the retired model onto a working OpenGateway model", async () => {
		const runtime = await refreshedRuntime();

		const restored = await restoreModelFromSession("opengateway", RETIRED, undefined, false, runtime);

		expect(restored.model).toMatchObject({ provider: "opengateway", id: OPENGATEWAY_DEFAULT });
		expect(restored.fallbackMessage).toContain(
			`Could not restore model opengateway/${RETIRED} (model no longer exists)`,
		);
	});

	it("keeps restoring a still-served saved model unchanged", async () => {
		const runtime = await refreshedRuntime();

		const restored = await restoreModelFromSession("opengateway", OPENGATEWAY_DEFAULT, undefined, false, runtime);

		expect(restored.model).toMatchObject({ provider: "opengateway", id: OPENGATEWAY_DEFAULT });
		expect(restored.fallbackMessage).toBeUndefined();
	});

	it("starts on a working model when the saved default is the retired model", async () => {
		const runtime = await refreshedRuntime();

		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "opengateway",
			defaultModelId: RETIRED,
			modelRuntime: runtime,
		});

		expect(initial.model).toMatchObject({ provider: "opengateway", id: OPENGATEWAY_DEFAULT });
		expect(initial.provenance).not.toBe("settings");
	});
});
