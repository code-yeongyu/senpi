import type { OAuthAuth } from "../types.ts";
import { loginOpenAICodexDeviceCode, refreshOpenAICodexToken } from "./openai-codex.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

export const openaiCodexDeviceOAuth: OAuthAuth = {
	name: "OpenAI (ChatGPT Plus/Pro, device code)",
	async login(callbacks) {
		const credentials = await loginOpenAICodexDeviceCode({
			onDeviceCode: (info) => callbacks.notify({ type: "device_code", ...info }),
			signal: callbacks.signal,
		});
		return { ...credentials, type: "oauth" };
	},
	refresh: async (credential) => ({ ...(await refreshOpenAICodexToken(credential.refresh)), type: "oauth" }),
	toAuth: async (credential) => ({ apiKey: credential.access }),
};

export const openaiCodexDeviceOAuthProvider: OAuthProviderInterface = {
	id: "openai-codex-device",
	name: "ChatGPT Plus/Pro (Codex, headless/device)",
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginOpenAICodexDeviceCode({
			onDeviceCode: callbacks.onDeviceCode,
			signal: callbacks.signal,
		});
	},
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshOpenAICodexToken(credentials.refresh);
	},
	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
