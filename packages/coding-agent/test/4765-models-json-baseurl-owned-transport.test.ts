import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	chatDefinition,
	createRuntime,
	EXTENSION_HOST,
	type ModelsJsonFile,
	modelsJsonFile,
	requireModel,
} from "./support/baseurl-override-fixture.ts";
import {
	type FetchGuard,
	installLoopbackFetchGuard,
	type LoopbackServer,
	startLoopbackServer,
} from "./support/loopback-network.ts";

const userContext: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

let server: LoopbackServer;
let guard: FetchGuard;
let models: ModelsJsonFile | undefined;
let seen: string[];
let sent: Promise<Response>[];

beforeEach(async () => {
	server = await startLoopbackServer();
	guard = installLoopbackFetchGuard();
	seen = [];
	sent = [];
});

afterEach(async () => {
	vi.unstubAllGlobals();
	models?.remove();
	models = undefined;
	await server.close();
});

/** Owned transport shaped like custom-provider-anthropic: it builds its client from `model.baseUrl`. */
function transportReadingModelBaseUrl(model: Model<Api>): never {
	seen.push(model.baseUrl);
	sent.push(fetch(`${model.baseUrl}/chat/completions`, { method: "POST", body: "{}" }));
	throw new Error("transport captured the request");
}

describe("senpi#4765 extension-supplied transports receive the models.json baseUrl", () => {
	it("hands an extension streamSimple model.baseUrl equal to the models.json baseUrl", async () => {
		models = modelsJsonFile({ "owned-ext": { baseUrl: server.url } });
		const runtime = await createRuntime(models.path);
		await runtime.registerProvider(
			"owned-ext",
			{
				baseUrl: EXTENSION_HOST,
				apiKey: "ext-key",
				api: "custom-loopback-api",
				models: [chatDefinition("owned-a")],
				streamSimple: transportReadingModelBaseUrl,
			},
			{ refresh: false },
		);

		await runtime.completeSimple(requireModel(runtime, "owned-ext", "owned-a"), userContext);
		await Promise.allSettled(sent);

		expect(seen).toEqual([server.url]);
		expect(guard.blocked).toEqual([]);
		expect(server.requests).toEqual(["/v1/chat/completions"]);
	});
});
