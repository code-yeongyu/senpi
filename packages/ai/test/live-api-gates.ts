import { execSync } from "child_process";

export const LIVE_API_TESTS_FLAG = "PI_ENABLE_LIVE_API_TESTS";
export const LOCAL_LLM_LIVE_TEST_FLAG = "PI_ENABLE_LOCAL_LLM";
export const OPENROUTER_LIVE_TEST_FLAG = "PI_ENABLE_OPENROUTER_LIVE";
export const BASETEN_LIVE_TEST_FLAG = "PI_ENABLE_BASETEN_LIVE";
export const QWEN_TOKEN_PLAN_LIVE_TEST_FLAG = "PI_ENABLE_QWEN_TOKEN_PLAN_LIVE";

const OAUTH_LIVE_TEST_FLAGS = {
	anthropic: "PI_ENABLE_ANTHROPIC_OAUTH_LIVE",
	"github-copilot": "PI_ENABLE_GITHUB_COPILOT_LIVE",
	"openai-codex": "PI_ENABLE_OPENAI_CODEX_LIVE",
} as const;

export function isLiveApiTestEnabled(providerFlag: string): boolean {
	return process.env[LIVE_API_TESTS_FLAG] === "1" || process.env[providerFlag] === "1";
}

export function isOllamaLiveTestAvailable(platform: NodeJS.Platform = process.platform): boolean {
	if (!isLiveApiTestEnabled(LOCAL_LLM_LIVE_TEST_FLAG)) return false;
	const command = platform === "win32" ? "where ollama" : "which ollama";
	try {
		execSync(command, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export function getLiveEnvApiKey(apiKeyEnvName: string, providerFlag: string): string | undefined {
	if (!isLiveApiTestEnabled(providerFlag)) return undefined;
	const apiKey = process.env[apiKeyEnvName]?.trim();
	return apiKey ? apiKey : undefined;
}

export function isOAuthLiveApiTestEnabled(provider: string): boolean {
	if (process.env[LIVE_API_TESTS_FLAG] === "1") return true;
	return process.env[getOAuthLiveTestFlag(provider) ?? ""] === "1";
}

function getOAuthLiveTestFlag(provider: string): string | undefined {
	return OAUTH_LIVE_TEST_FLAGS[provider as keyof typeof OAUTH_LIVE_TEST_FLAGS];
}
