import type { Model } from "@earendil-works/pi-ai";

export const CODEX_MODEL = {
	id: "gpt-6-astra",
	name: "GPT-6 Astra",
	api: "openai-codex-responses",
	provider: "chatgpt-subscription",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 16_384,
} satisfies Model<"openai-codex-responses">;

export const OPENAI_MODEL = {
	...CODEX_MODEL,
	id: "gpt-5.6-sol",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
} satisfies Model<"openai-responses">;

export const GATEWAY_MODEL = {
	...OPENAI_MODEL,
	provider: "local-gateway",
	baseUrl: "http://127.0.0.1:4141/v1",
	compat: { supportsRemoteCompactionV2: true },
} satisfies Model<"openai-responses">;

export function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account_2434" } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}
