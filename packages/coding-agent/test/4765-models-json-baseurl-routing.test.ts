import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

beforeAll(() => {
	registerBuiltInApiProviders();
});

beforeEach(async () => {
	server = await startLoopbackServer();
	guard = installLoopbackFetchGuard();
});

afterEach(async () => {
	vi.unstubAllGlobals();
	models?.remove();
	models = undefined;
	await server.close();
});

describe("senpi#4765 models.json baseUrl routes requests", () => {
	it("sends an extension provider's chat request to the models.json provider baseUrl", async () => {
		models = modelsJsonFile({ "ext-proxy": { baseUrl: server.url } });
		const runtime = await createRuntime(models.path);
		await runtime.registerProvider(
			"ext-proxy",
			{ baseUrl: EXTENSION_HOST, apiKey: "ext-key", api: "openai-completions", models: [chatDefinition("chat-a")] },
			{ refresh: false },
		);

		const reply = await runtime.completeSimple(requireModel(runtime, "ext-proxy", "chat-a"), userContext);

		expect(guard.blocked).toEqual([]);
		expect(reply.errorMessage).toBeUndefined();
		expect(server.requests).toEqual(["/v1/chat/completions"]);
		expect(reply.stopReason).toBe("stop");
	});

	it("keeps a built-in provider's models.json baseUrl override working", async () => {
		models = modelsJsonFile({ deepseek: { baseUrl: server.url, apiKey: "loopback-key" } });
		const runtime = await createRuntime(models.path);
		const model = requireModel(runtime, "deepseek", "deepseek-flash");
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe(server.url);

		await runtime.completeSimple(model, userContext);

		expect(guard.blocked).toEqual([]);
		expect(server.requests).toEqual(["/v1/chat/completions"]);
	});

	it("keeps a transport layered onto a models.json custom provider streaming to the user URL", async () => {
		models = modelsJsonFile({
			layered: { baseUrl: server.url, api: "openai-completions", apiKey: "k", models: [{ id: "layered-model" }] },
		});
		const runtime = await createRuntime(models.path);
		const seen: string[] = [];
		const sent: Promise<Response>[] = [];
		await runtime.registerProvider(
			"layered",
			{
				api: "openai-completions",
				streamSimple: (model: Model<Api>) => {
					seen.push(model.baseUrl);
					sent.push(fetch(`${model.baseUrl}/chat/completions`, { method: "POST", body: "{}" }));
					throw new Error("transport captured the request");
				},
			},
			{ refresh: false },
		);

		await runtime.completeSimple(requireModel(runtime, "layered", "layered-model"), userContext);
		await Promise.all(sent);

		expect(seen).toEqual([server.url]);
		expect(guard.blocked).toEqual([]);
		expect(server.requests).toEqual(["/v1/chat/completions"]);
	});
});
