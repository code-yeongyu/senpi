import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { githubCopilotOAuth } from "../src/auth/oauth/github-copilot.ts";
import { createModels } from "../src/models.ts";
import { githubCopilotProvider } from "../src/providers/github-copilot.ts";
import type { AssistantMessage } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";

const signal = new AbortController().signal;
const accessToken = "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;";
const modelsUrl = "https://api.individual.githubcopilot.com/models";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function requestUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	return input instanceof URL ? input.toString() : input.url;
}

function modelEntry(
	id: string,
	limits: Record<string, unknown>,
): {
	id: string;
	model_picker_enabled: true;
	capabilities: { supports: { tool_calls: true }; limits: Record<string, unknown> };
} {
	return {
		id,
		model_picker_enabled: true,
		capabilities: {
			supports: { tool_calls: true },
			limits,
		},
	};
}

function stubRefreshCatalog(data: readonly unknown[]): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request): Promise<Response> => {
			const url = requestUrl(input);
			if (url.includes("/copilot_internal/v2/token")) {
				return jsonResponse({ token: accessToken, expires_at: 9999999999 });
			}
			if (url === modelsUrl) return jsonResponse({ data });
			throw new Error(`Unexpected fetch URL: ${url}`);
		}),
	);
}

function stubLoginCatalog(data: readonly unknown[]): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request): Promise<Response> => {
			const url = requestUrl(input);
			if (url.endsWith("/login/device/code")) {
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://github.com/login/device",
					interval: 1,
					expires_in: 900,
				});
			}
			if (url.endsWith("/login/oauth/access_token")) {
				return jsonResponse({ access_token: "github-access-token" });
			}
			if (url.includes("/copilot_internal/v2/token")) {
				return jsonResponse({ token: accessToken, expires_at: 9999999999 });
			}
			if (url === modelsUrl) return jsonResponse({ data });
			throw new Error(`Unexpected fetch URL: ${url}`);
		}),
	);
}

async function availableModelsForCredential(credential: Awaited<ReturnType<typeof githubCopilotOAuth.refresh>>) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("github-copilot", async () => credential);
	const models = createModels({ credentials });
	models.setProvider(githubCopilotProvider());
	return models.getAvailable("github-copilot");
}

function errorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "github-copilot",
		model: "gpt-5.4",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

// senpi#2299
describe("GitHub Copilot account model limits", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("uses refreshed prompt and output limits for available models", async () => {
		stubRefreshCatalog([
			modelEntry("gpt-5.4", {
				max_context_window_tokens: 400_000,
				max_prompt_tokens: 272_000,
				max_output_tokens: 128_000,
			}),
		]);

		const credential = await githubCopilotOAuth.refresh(
			{ type: "oauth", access: "expired", refresh: "refresh-token", expires: 0 },
			signal,
		);
		const available = await availableModelsForCredential(credential);

		expect(available).toHaveLength(1);
		expect(available[0]).toMatchObject({
			id: "gpt-5.4",
			contextWindow: 272_000,
			maxTokens: 128_000,
		});
	});

	it("persists login limits and falls back safely when fields are absent or invalid", async () => {
		vi.useFakeTimers();
		const provider = githubCopilotProvider();
		const baseline = provider.getModels();
		const contextOnly = baseline.find((model) => model.id === "kimi-k3");
		const malformed = baseline.find((model) => model.id === "claude-opus-5.5");
		if (!contextOnly || !malformed) throw new Error("Expected Copilot fixture models");
		stubLoginCatalog([
			modelEntry(contextOnly.id, {
				max_context_window_tokens: 262_144,
				max_output_tokens: 32_768,
			}),
			modelEntry(malformed.id, {
				max_context_window_tokens: -1,
				max_prompt_tokens: "200000",
				max_output_tokens: 0,
			}),
		]);

		const credentials = new InMemoryCredentialStore();
		const models = createModels({ credentials });
		models.setProvider(provider);
		const pending = models.login("github-copilot", "oauth", {
			signal,
			prompt: async () => "",
			notify: () => {},
		});
		await vi.advanceTimersByTimeAsync(1000);
		await pending;
		const available = await models.getAvailable("github-copilot");

		expect(available.find((model) => model.id === contextOnly.id)).toMatchObject({
			contextWindow: 262_144,
			maxTokens: 32_768,
		});
		expect(available.find((model) => model.id === malformed.id)).toMatchObject({
			contextWindow: malformed.contextWindow,
			maxTokens: malformed.maxTokens,
		});
	});

	it("classifies Copilot's recorded prompt-cap rejection as context overflow", () => {
		const response = errorMessage(
			'400 {"error":{"message":"prompt token count of 13613 exceeds the limit of 12288","code":"model_max_prompt_tokens_exceeded"}}',
		);

		expect(isContextOverflow(response, 12_288)).toBe(true);
	});

	it("classifies the Copilot prompt-cap error code when a wrapper omits the prose", () => {
		const response = errorMessage('400 {"error":{"code":"model_max_prompt_tokens_exceeded"}}');

		expect(isContextOverflow(response, 12_288)).toBe(true);
	});
});
