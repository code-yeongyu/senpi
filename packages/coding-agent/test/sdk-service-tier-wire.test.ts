import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ServiceTier } from "../src/core/extensions/builtin/service-tier.ts";
import type { ProviderConfigInput } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

// Chat member of the chat/image/classifier model-config union.
type RegisteredModel = Extract<NonNullable<ProviderConfigInput["models"]>[number], { type?: "chat" }>;

const PROVIDER = "tier-provider";
const BASE_MODEL_ID = "tier-base";
const FAST_MODEL_ID = `${BASE_MODEL_ID}-fast`;

/**
 * The request tier is a SESSION property, not an extension feature: an embedded/SDK session that
 * loads no builtin extensions (a delegated child, an app-server host) must still send the tier a
 * `-fast` catalog variant or session fast mode asks for. Every session here is extension-less.
 */
describe("createAgentSession request service tier without extensions", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-service-tier-wire-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	type Captured = {
		readonly options: SimpleStreamOptions | undefined;
	};

	async function withSession(
		api: Api,
		run: (
			session: Awaited<ReturnType<typeof createAgentSession>>["session"],
			models: { readonly base: Model<Api>; readonly fast: Model<Api> },
			captured: Captured,
		) => Promise<void>,
		serviceTier?: ServiceTier,
		provider: string = PROVIDER,
	): Promise<void> {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const captured: { options: SimpleStreamOptions | undefined } = { options: undefined };
		const modelShape = {
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		} satisfies Omit<RegisteredModel, "id" | "name">;
		modelRegistry.registerProvider(provider, {
			api,
			baseUrl: "https://tier.invalid/v1",
			models: [
				{ id: BASE_MODEL_ID, name: "Tier Base", ...modelShape },
				{
					id: FAST_MODEL_ID,
					name: "Tier Base Fast",
					upstreamModelId: BASE_MODEL_ID,
					serviceTier: "priority",
					...modelShape,
				},
			],
			streamSimple: (_model, _context, providerOptions) => {
				captured.options = providerOptions;
				return doneStream(api);
			},
		});
		const base = modelRegistry.find(provider, BASE_MODEL_ID);
		const fast = modelRegistry.find(provider, FAST_MODEL_ID);
		if (!base || !fast) throw new Error("test provider models did not register");

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: base,
			serviceTier,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager: SettingsManager.inMemory({}),
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader: createTestResourceLoader(),
		});
		try {
			await run(session, { base, fast }, captured);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(provider);
		}
	}

	async function requestTier(
		session: Awaited<ReturnType<typeof createAgentSession>>["session"],
		model: Model<Api>,
		captured: Captured,
		requestOptions: SimpleStreamOptions = {},
	): Promise<ServiceTier | undefined> {
		const stream = await session.agent.streamFunction(model, normalizeContext({ messages: [] }), requestOptions);
		await stream.result();
		return captured.options?.serviceTier;
	}

	it.each(["openai-responses", "openai-codex-responses"] as const)(
		"sends an initial Ultrafast tier on %s",
		async (api) => {
			await withSession(
				api,
				async (session, models, captured) => {
					expect(session.serviceTier).toBe("ultrafast");
					session.setSessionFastMode(true);
					expect(session.isFastModeActive()).toBe(false);
					expect(await requestTier(session, models.base, captured)).toBe("ultrafast");
				},
				"ultrafast",
				"openai",
			);
		},
	);

	it("never sends Ultrafast to a provider other than OpenAI and ChatGPT Subscription", async () => {
		await withSession(
			"openai-responses",
			async (session, models, captured) => {
				expect(session.serviceTier).toBe("ultrafast");
				expect(await requestTier(session, models.base, captured)).toBeUndefined();
				expect(await requestTier(session, models.base, captured, { serviceTier: "ultrafast" })).toBeUndefined();
				expect(await requestTier(session, models.base, captured, { serviceTier: "priority" })).toBe("priority");
			},
			"ultrafast",
		);
	});

	it("sends the catalog priority tier of a -fast variant selected on an extension-less session", async () => {
		await withSession("openai-codex-responses", async (session, models, captured) => {
			// given: no service-tier extension is loaded, only the catalog says priority
			await session.setSessionModel(models.fast);
			expect(session.serviceTier).toBe("priority");

			// when
			const tier = await requestTier(session, models.fast, captured);

			// then
			expect(tier).toBe("priority");
		});
	});

	it("sends the native Sol Ultrafast alias as Sol with its default tier and effort without extensions", async () => {
		// Given: the builtin catalog, no models.json alias or service-tier extension.
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.test`;
		await authStorage.modify("chatgpt-subscription", async () => ({
			type: "oauth",
			access: token,
			refresh: "test-refresh",
			expires: Number.MAX_SAFE_INTEGER,
		}));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const model = modelRegistry.find("chatgpt-subscription", "gpt-6.1-sol-ultrafast");
		if (!model) throw new Error("Missing native Sol Ultrafast model");
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager: SettingsManager.inMemory({}),
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader: createTestResourceLoader(),
		});
		let payload: unknown;
		let headers: Headers | undefined;
		try {
			// When: the session's real stream function reaches the subscription adapter.
			const stream = await session.agent.streamFunction(
				model,
				normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] }),
				{
					transport: "sse",
					reasoning: session.thinkingLevel === "off" ? undefined : session.thinkingLevel,
					fetch: async (input, init) => {
						const request = new Request(input, init);
						headers = request.headers;
						const bytes = Buffer.from(await request.arrayBuffer());
						const body = headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
						payload = JSON.parse(body.toString("utf8"));
						return new Response(
							`data: ${JSON.stringify({
								type: "response.completed",
								response: {
									status: "completed",
									service_tier: "default",
									output: [],
									usage: { input_tokens: 100_000, output_tokens: 1000 },
								},
							})}\n\n`,
							{ headers: { "content-type": "text/event-stream" } },
						);
					},
				},
			);
			const result = await stream.result();

			// Then: the catalog ID never leaks onto the wire, and Sol uses the published 6x multiplier.
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(session.serviceTier).toBe("ultrafast");
			expect(session.thinkingLevel).toBe("xhigh");
			expect(payload).toMatchObject({
				model: "gpt-6.1-sol",
				service_tier: "ultrafast",
				reasoning: { effort: "xhigh" },
			});
			expect(headers?.get("x-codex-routing-hint")).toBe("model=gpt-6.1-sol;tier=ultrafast");
			expect(result.usage.cost.input).toBeCloseTo(1.2);
			expect(result.usage.cost.output).toBeCloseTo(0.06);
		} finally {
			session.dispose();
		}
	});

	it("sends priority once session fast mode is turned on for a Codex base model", async () => {
		await withSession("openai-codex-responses", async (session, models, captured) => {
			// given
			expect(await requestTier(session, models.base, captured)).toBeUndefined();

			// when
			session.setSessionFastMode(true);

			// then
			expect(await requestTier(session, models.base, captured)).toBe("priority");

			session.setSessionFastMode(false);
			expect(await requestTier(session, models.base, captured)).toBeUndefined();
		});
	});

	it("never sends a tier to an API that has no service_tier field", async () => {
		await withSession("anthropic-messages", async (session, models, captured) => {
			// given
			session.setSessionFastMode(true);
			expect(session.isFastModeActive()).toBe(true);

			// when
			const tier = await requestTier(session, models.base, captured);

			// then
			expect(tier).toBeUndefined();
		});
	});

	it("lets an explicit request tier outrank the session tier", async () => {
		await withSession("openai-responses", async (session, models, captured) => {
			// given
			session.setSessionFastMode(true);

			// when
			const tier = await requestTier(session, models.base, captured, { serviceTier: "flex" });

			// then
			expect(tier).toBe("flex");
		});
	});

	it("uses the request model's own catalog tier when it is not the session model", async () => {
		await withSession("openai-responses", async (session, models, captured) => {
			// given: the session sits on the base model with fast mode off
			expect(session.effectiveServiceTier).toBeUndefined();

			// when: a side request (summaries use the same stream function) names the -fast variant
			const tier = await requestTier(session, models.fast, captured);

			// then
			expect(tier).toBe("priority");
		});
	});
});

function doneStream(api: Api) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api,
		provider: PROVIDER,
		model: BASE_MODEL_ID,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.end(message);
	return stream;
}
