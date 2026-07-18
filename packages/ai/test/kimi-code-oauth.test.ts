import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getOAuthProvider } from "../src/auth/oauth/index.ts";
import { loginKimi, refreshKimiToken } from "../src/auth/oauth/kimi-code.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe.sequential("Kimi Code OAuth", () => {
	let agentDir: string;
	const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;

	beforeAll(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "senpi-kimi-oauth-"));
		process.env.SENPI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	afterAll(async () => {
		if (originalAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
		else process.env.SENPI_CODING_AGENT_DIR = originalAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	it("logs in with device authorization and refreshes without exposing tokens", async () => {
		const issuedAt = Date.parse("2026-07-12T00:00:00Z");
		vi.spyOn(Date, "now").mockReturnValue(issuedAt);
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				requests.push({ url, init });
				if (url.endsWith("/device_authorization")) {
					return jsonResponse({
						user_code: "KIMI-1234",
						device_code: "device-secret",
						verification_uri: "https://auth.kimi.com/device",
						verification_uri_complete: "https://auth.kimi.com/device?user_code=KIMI-1234",
						expires_in: 900,
						interval: 5,
					});
				}
				if (url.endsWith("/token")) {
					const body = new URLSearchParams(String(init?.body));
					return body.get("grant_type") === "refresh_token"
						? jsonResponse({ access_token: "access-refreshed", expires_in: 3600 })
						: jsonResponse({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600 });
				}
				throw new Error(`Unexpected URL: ${url}`);
			}),
		);

		const deviceCodes: Array<{ userCode: string; verificationUri: string }> = [];
		const credentials = await loginKimi({
			onAuth: () => {},
			onDeviceCode: (info) => deviceCodes.push(info),
			onPrompt: async () => "",
			onSelect: async () => undefined,
		});
		expect(deviceCodes).toEqual([
			{
				userCode: "KIMI-1234",
				verificationUri: "https://auth.kimi.com/device?user_code=KIMI-1234",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
		expect(credentials).toEqual({
			access: "access-secret",
			refresh: "refresh-secret",
			expires: issuedAt + 55 * 60_000,
		});

		const authorizationBody = new URLSearchParams(String(requests[0]?.init?.body));
		expect(authorizationBody.get("client_id")).toBe("17e5f671-d194-4dfb-9706-5516cb48c098");
		const tokenBody = new URLSearchParams(String(requests[1]?.init?.body));
		expect(tokenBody.get("device_code")).toBe("device-secret");
		expect(requests[1]?.init?.signal).toBeInstanceOf(AbortSignal);

		const refreshed = await refreshKimiToken(credentials.refresh);
		expect(refreshed).toEqual({
			access: "access-refreshed",
			refresh: "refresh-secret",
			expires: issuedAt + 55 * 60_000,
		});
		expect(getOAuthProvider("kimi-code")?.id).toBe("kimi-code");
	});

	it("rejects an untrusted verification URI before presenting it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					user_code: "KIMI-1234",
					device_code: "device-secret",
					verification_uri: "https://phishing.example/device",
				}),
			),
		);

		await expect(
			loginKimi({
				onAuth: () => {},
				onDeviceCode: () => {},
				onPrompt: async () => "",
				onSelect: async () => undefined,
			}),
		).rejects.toThrow("unexpected verification URI");
	});

	it("cancels before polling after the device code is presented", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				user_code: "KIMI-1234",
				device_code: "device-secret",
				verification_uri: "https://auth.kimi.com/device",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			loginKimi({
				onAuth: () => {},
				onDeviceCode: () => controller.abort(),
				onPrompt: async () => "",
				onSelect: async () => undefined,
				signal: controller.signal,
			}),
		).rejects.toThrow("Login cancelled");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps refresh credentials out of endpoint errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid_grant", refresh_token: "leaked-token" }, 400)),
		);
		const error = await refreshKimiToken("refresh-secret").catch((value: unknown) => value);
		expect(String(error)).not.toContain("refresh-secret");
		expect(String(error)).not.toContain("leaked-token");
	});
});
