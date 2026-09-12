import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kimiCodingOAuth } from "../src/auth/oauth/kimi-coding.ts";
import { resetKimiDeviceIdForTests } from "../src/auth/oauth/kimi-identity.ts";
import type { ProviderAuthInteraction } from "../src/auth/types.ts";
import { kimiCodingProvider } from "../src/providers/kimi-coding.ts";

const OAUTH_HOST = "https://auth.kimi.com";
const IDENTITY_HEADER_NAMES = [
	"X-Msh-Platform",
	"X-Msh-Version",
	"X-Msh-Device-Name",
	"X-Msh-Device-Model",
	"X-Msh-Os-Version",
	"X-Msh-Device-Id",
] as const;

const credential = {
	type: "oauth",
	access: "access-token",
	refresh: "refresh-token",
	expires: Date.now() + 3_600_000,
} as const;

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
	const raw = (init?.headers ?? {}) as Record<string, string>;
	const normalized: Record<string, string> = {};
	for (const [name, value] of Object.entries(raw)) normalized[name.toLowerCase()] = value;
	return normalized;
}

function interaction(): ProviderAuthInteraction {
	return {
		signal: new AbortController().signal,
		prompt: async () => {
			throw new Error("Kimi Code login should not prompt");
		},
		notify: () => {},
	};
}

describe("Kimi Code client identity headers", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "senpi-kimi-identity-"));
		vi.stubEnv("SENPI_CODING_AGENT_DIR", agentDir);
		resetKimiDeviceIdForTests();
	});

	afterEach(() => {
		resetKimiDeviceIdForTests();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	it("derives request auth carrying the bearer token and every identity header", async () => {
		const auth = await kimiCodingOAuth.toAuth(credential);
		const headers = auth.headers ?? {};

		expect(headers.Authorization).toBe("Bearer access-token");
		expect(String(headers["User-Agent"] ?? "")).toMatch(/^KimiCLI\//);
		for (const name of IDENTITY_HEADER_NAMES) {
			expect(String(headers[name] ?? ""), `missing ${name}`).not.toHaveLength(0);
		}
	});

	it("keeps every header value printable ASCII", async () => {
		const auth = await kimiCodingOAuth.toAuth(credential);

		for (const [name, value] of Object.entries(auth.headers ?? {})) {
			expect(String(value), `non-ascii in ${name}`).toMatch(/^[\x20-\x7E]*$/);
		}
	});

	it("persists one device id under the agent dir and reuses it", async () => {
		const first = await kimiCodingOAuth.toAuth(credential);
		const deviceId = String(first.headers?.["X-Msh-Device-Id"] ?? "");
		const storePath = join(agentDir, "kimi-device-id");

		expect(deviceId).not.toHaveLength(0);
		expect(existsSync(storePath)).toBe(true);
		expect(readFileSync(storePath, "utf-8").trim()).toBe(deviceId);

		resetKimiDeviceIdForTests();
		const second = await kimiCodingOAuth.toAuth(credential);
		expect(second.headers?.["X-Msh-Device-Id"]).toBe(deviceId);
	});

	it("falls back to an ephemeral device id when the agent dir cannot be written", async () => {
		vi.stubEnv("SENPI_CODING_AGENT_DIR", join("/dev/null", "unwritable-agent-dir"));
		resetKimiDeviceIdForTests();

		const auth = await kimiCodingOAuth.toAuth(credential);

		expect(String(auth.headers?.["X-Msh-Device-Id"] ?? "")).not.toHaveLength(0);
	});

	it("sends the identity headers on device authorization and token polling", async () => {
		vi.useFakeTimers();
		const seen: Record<string, string>[] = [];
		const pollResponses = [
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				seen.push(headerRecord(init));
				if (String(input) === `${OAUTH_HOST}/api/oauth/device_authorization`) {
					return jsonResponse({
						user_code: "ABCD-1234",
						device_code: "device-code-123",
						verification_uri: "https://www.kimi.com/code",
						verification_uri_complete: "https://www.kimi.com/code?user_code=ABCD-1234",
						interval: 5,
						expires_in: 600,
					});
				}
				const response = pollResponses.shift();
				if (!response) throw new Error("Unexpected extra token poll");
				return response;
			}),
		);

		const login = kimiCodingOAuth.login(interaction());
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(login).resolves.toMatchObject({ access: "access-token" });

		expect(seen.length).toBeGreaterThanOrEqual(2);
		for (const headers of seen) {
			for (const name of IDENTITY_HEADER_NAMES) {
				expect(headers, `missing ${name}`).toHaveProperty(name.toLowerCase());
			}
		}
	});

	it("sends the identity headers on token refresh", async () => {
		const seen: Record<string, string>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
				seen.push(headerRecord(init));
				return jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 });
			}),
		);

		await kimiCodingOAuth.refresh(
			{ type: "oauth", access: "old", refresh: "old-refresh", expires: 0 },
			new AbortController().signal,
		);

		expect(seen).toHaveLength(1);
		for (const name of IDENTITY_HEADER_NAMES) {
			expect(seen[0], `missing ${name}`).toHaveProperty(name.toLowerCase());
		}
	});

	it("leaves the api-key path free of identity headers", async () => {
		const resolved = await kimiCodingProvider().auth.apiKey?.resolve({
			ctx: { env: async () => undefined } as never,
			credential: { type: "api_key", key: "platform-key" },
			signal: new AbortController().signal,
		});

		expect(resolved?.auth.apiKey).toBe("platform-key");
		expect(resolved?.auth.headers).toBeUndefined();
	});
});
