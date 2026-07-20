import { afterEach, describe, expect, it, vi } from "vitest";
import { getOAuthProvider, resolveOAuthStorageProvider } from "../src/auth/oauth/index.ts";
import { openaiCodexDeviceOAuthProvider } from "../src/auth/oauth/openai-codex-device.ts";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function accessToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64");
	return `${header}.${payload}.signature`;
}

describe("OpenAI Codex device OAuth provider", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("uses the existing device login and refresh implementation under its own ID", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url.endsWith("/deviceauth/usercode")) {
					return jsonResponse({ device_auth_id: "device-id", user_code: "OPENAI-1234", interval: 5 });
				}
				if (url.endsWith("/deviceauth/token")) {
					return jsonResponse({ authorization_code: "code", code_verifier: "verifier" });
				}
				if (url.endsWith("/oauth/token")) {
					const body = new URLSearchParams(String(init?.body));
					return body.get("grant_type") === "refresh_token"
						? jsonResponse({
								access_token: accessToken("account-refreshed"),
								refresh_token: "refresh-2",
								expires_in: 3600,
							})
						: jsonResponse({
								access_token: accessToken("account-device"),
								refresh_token: "refresh-1",
								expires_in: 3600,
							});
				}
				throw new Error(`Unexpected URL: ${url}`);
			}),
		);

		const deviceCodes: string[] = [];
		const credentials = await openaiCodexDeviceOAuthProvider.login({
			onAuth: () => {
				throw new Error("Browser login must not be used");
			},
			onDeviceCode: (info) => deviceCodes.push(info.userCode),
			onPrompt: async () => {
				throw new Error("Text prompt must not be used");
			},
			onSelect: async () => {
				throw new Error("Login method selector must not be used");
			},
		});
		expect(deviceCodes).toEqual(["OPENAI-1234"]);
		expect(credentials.accountId).toBe("account-device");

		const refreshed = await openaiCodexDeviceOAuthProvider.refreshToken(credentials);
		expect(refreshed.accountId).toBe("account-refreshed");
		expect(getOAuthProvider("openai-codex-device")?.id).toBe("openai-codex-device");
		expect(resolveOAuthStorageProvider("openai-codex-device")).toBe("openai-codex");
	});
});
