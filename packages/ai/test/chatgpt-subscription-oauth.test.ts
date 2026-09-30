import { afterEach, describe, expect, it, vi } from "vitest";
import { chatgptSubscriptionOAuth } from "../src/auth/oauth/chatgpt-subscription.ts";
import { validateChatGptSubscriptionIdentity } from "../src/utils/chatgpt-subscription-auth.ts";

const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function createAccessToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: accountId,
			},
		}),
	).toString("base64");
	return `${header}.${payload}.signature`;
}

function base64Url(value: Uint8Array): string {
	return Buffer.from(value).toString("base64url");
}

async function createIdentityFixture(claims: Record<string, unknown> = {}, rawPayload?: string) {
	const keyPair = await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	);
	const header = base64Url(Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })));
	const payloadClaims = JSON.stringify({
		iss: "https://auth.openai.com",
		aud: "app_EMoamEEZ73f0CkXaXp7hrann",
		exp: 1_800_000_000,
		sub: "user-123",
		email: "person@example.test",
		email_verified: true,
		"https://api.openai.com/auth": { chatgpt_account_id: "workspace-123" },
		...claims,
	});
	const payload = base64Url(Buffer.from(rawPayload ?? payloadClaims));
	const signingInput = `${header}.${payload}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, Buffer.from(signingInput));
	const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
	return {
		idToken: `${signingInput}.${base64Url(new Uint8Array(signature))}`,
		jwks: { keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] },
	};
}

function deviceAuthPendingResponse(): Response {
	return jsonResponse(
		{
			error: {
				message: "Device authorization is pending. Please try again.",
				type: "invalid_request_error",
				param: null,
				code: "deviceauth_authorization_pending",
			},
		},
		403,
	);
}

function loginChatGptSubscriptionDeviceCodeForTest(options: {
	onDeviceCode(info: {
		userCode: string;
		verificationUri: string;
		intervalSeconds?: number;
		expiresInSeconds?: number;
	}): void;
	signal?: AbortSignal;
}) {
	return chatgptSubscriptionOAuth.login({
		signal: options.signal ?? neverAbortedSignal,
		prompt: async (prompt) => {
			if (prompt.type !== "select") throw new Error(`Unexpected prompt: ${prompt.type}`);
			return "device_code";
		},
		notify: (event) => {
			if (event.type === "device_code") {
				const { type: _, ...info } = event;
				options.onDeviceCode(info);
			}
		},
	});
}

describe("OpenAI Codex OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("validates signed optional identity and rejects invalid claims without retaining the token", async () => {
		const valid = await createIdentityFixture();
		const wrongIssuer = await createIdentityFixture({ iss: "https://issuer.invalid" });
		const options = { fetch: async () => jsonResponse(valid.jwks), now: () => 1_700_000_000_000 };

		const identity = await validateChatGptSubscriptionIdentity(valid.idToken, options);

		expect(identity).toEqual({
			userId: "user-123",
			workspaceId: "workspace-123",
			verifiedEmail: "person@example.test",
		});
		expect(JSON.stringify(identity)).not.toContain(valid.idToken);
		await expect(
			validateChatGptSubscriptionIdentity(wrongIssuer.idToken, {
				...options,
				fetch: async () => jsonResponse(wrongIssuer.jwks),
			}),
		).resolves.toBeUndefined();
		await expect(validateChatGptSubscriptionIdentity("not-a-jwt", options)).resolves.toBeUndefined();
	});

	it.each([
		["wrong audience", { aud: "another-client" }],
		["wrong authorized party", { azp: "another-client" }],
		[
			"wrong authorized party with multiple audiences",
			{
				aud: ["app_EMoamEEZ73f0CkXaXp7hrann", "another-client"],
				azp: "another-client",
			},
		],
		[
			"missing authorized party with multiple audiences",
			{
				aud: ["app_EMoamEEZ73f0CkXaXp7hrann", "another-client"],
			},
		],
		["expired claims", { exp: 1_600_000_000 }],
		["missing person", { sub: "" }],
		["missing workspace", { "https://api.openai.com/auth": {} }],
	])("ignores optional identity with %s", async (_case, claims) => {
		const fixture = await createIdentityFixture(claims);
		await expect(
			validateChatGptSubscriptionIdentity(fixture.idToken, {
				fetch: async () => jsonResponse(fixture.jwks),
				now: () => 1_700_000_000_000,
			}),
		).resolves.toBeUndefined();
	});

	it("rejects a signed ID token whose JSON expiry overflows to infinity", async () => {
		const fixture = await createIdentityFixture(
			{},
			`{
			"iss": "https://auth.openai.com",
			"aud": "app_EMoamEEZ73f0CkXaXp7hrann",
			"exp": 1e400,
			"sub": "user-123",
			"https://api.openai.com/auth": { "chatgpt_account_id": "workspace-123" }
		}`,
		);
		await expect(
			validateChatGptSubscriptionIdentity(fixture.idToken, {
				fetch: async () => jsonResponse(fixture.jwks),
				now: () => 1_700_000_000_000,
			}),
		).resolves.toBeUndefined();
	});

	it("accepts multiple audiences when this client is the authorized party", async () => {
		const fixture = await createIdentityFixture({
			aud: ["app_EMoamEEZ73f0CkXaXp7hrann", "another-client"],
			azp: "app_EMoamEEZ73f0CkXaXp7hrann",
		});
		await expect(
			validateChatGptSubscriptionIdentity(fixture.idToken, {
				fetch: async () => jsonResponse(fixture.jwks),
				now: () => 1_700_000_000_000,
			}),
		).resolves.toEqual({
			userId: "user-123",
			workspaceId: "workspace-123",
			verifiedEmail: "person@example.test",
		});
	});

	it("ignores an optional identity token signed by an unknown key", async () => {
		const signed = await createIdentityFixture();
		const other = await createIdentityFixture();
		await expect(
			validateChatGptSubscriptionIdentity(signed.idToken, {
				fetch: async () => jsonResponse(other.jwks),
				now: () => 1_700_000_000_000,
			}),
		).resolves.toBeUndefined();
	});

	it("rejects a token with the expected key ID but a modified signature", async () => {
		const fixture = await createIdentityFixture();
		const signature = Buffer.from(fixture.idToken.split(".").at(-1) ?? "", "base64url");
		signature[0] ^= 1;
		const tampered = `${fixture.idToken.slice(0, fixture.idToken.lastIndexOf(".") + 1)}${signature.toString("base64url")}`;
		await expect(
			validateChatGptSubscriptionIdentity(tampered, {
				fetch: async () => jsonResponse(fixture.jwks),
				now: () => 1_700_000_000_000,
			}),
		).resolves.toBeUndefined();
	});

	it("omits an unverified email from otherwise verified identity", async () => {
		const fixture = await createIdentityFixture({ email_verified: false });

		await expect(
			validateChatGptSubscriptionIdentity(fixture.idToken, {
				fetch: async () => jsonResponse(fixture.jwks),
				now: () => 1_700_000_000_000,
			}),
		).resolves.toEqual({ userId: "user-123", workspaceId: "workspace-123" });
	});

	it.each(["missing-at-sign.example.test", "person@example", "person\n@example.test", "person\u001b@example.test"])(
		"omits non-printable or unusable verified email %j",
		async (email) => {
			const fixture = await createIdentityFixture({ email });

			await expect(
				validateChatGptSubscriptionIdentity(fixture.idToken, {
					fetch: async () => jsonResponse(fixture.jwks),
					now: () => 1_700_000_000_000,
				}),
			).resolves.toEqual({ userId: "user-123", workspaceId: "workspace-123" });
		},
	);

	it("binds device-code identity to the access-token workspace from the same exchange", async () => {
		const fixture = await createIdentityFixture();
		const accessToken = createAccessToken("workspace-123");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url.endsWith("/usercode"))
					return jsonResponse({ device_auth_id: "device", user_code: "ABCD", interval: 0 });
				if (url.endsWith("/deviceauth/token"))
					return jsonResponse({ authorization_code: "code", code_verifier: "verifier" });
				if (url.endsWith("/oauth/token"))
					return jsonResponse({
						access_token: accessToken,
						refresh_token: "refresh",
						expires_in: 3600,
						id_token: fixture.idToken,
					});
				if (url.endsWith("/.well-known/jwks.json")) return jsonResponse(fixture.jwks);
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		await expect(loginChatGptSubscriptionDeviceCodeForTest({ onDeviceCode: () => {} })).resolves.toMatchObject({
			verifiedIdentity: { userId: "user-123", workspaceId: "workspace-123", verifiedEmail: "person@example.test" },
		});
	});

	it("binds browser identity through the same authorization-code exchange", async () => {
		const fixture = await createIdentityFixture();
		const accessToken = createAccessToken("workspace-123");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url.endsWith("/oauth/token"))
					return jsonResponse({
						access_token: accessToken,
						refresh_token: "refresh",
						expires_in: 3600,
						id_token: fixture.idToken,
					});
				if (url.endsWith("/.well-known/jwks.json")) return jsonResponse(fixture.jwks);
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credential = await chatgptSubscriptionOAuth.login({
			signal: neverAbortedSignal,
			prompt: async (prompt) => (prompt.type === "select" ? "browser" : "browser-code"),
			notify: () => {},
		});

		expect(credential.verifiedIdentity).toEqual({
			userId: "user-123",
			workspaceId: "workspace-123",
			verifiedEmail: "person@example.test",
		});
	});

	it("keeps login valid but unverified when identity conflicts with the access-token workspace", async () => {
		const fixture = await createIdentityFixture();
		const accessToken = createAccessToken("different-workspace");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url.endsWith("/usercode"))
					return jsonResponse({ device_auth_id: "device", user_code: "ABCD", interval: 0 });
				if (url.endsWith("/deviceauth/token"))
					return jsonResponse({ authorization_code: "code", code_verifier: "verifier" });
				if (url.endsWith("/oauth/token"))
					return jsonResponse({
						access_token: accessToken,
						refresh_token: "refresh",
						expires_in: 3600,
						id_token: fixture.idToken,
					});
				if (url.endsWith("/.well-known/jwks.json")) return jsonResponse(fixture.jwks);
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credential = await loginChatGptSubscriptionDeviceCodeForTest({ onDeviceCode: () => {} });

		expect(credential).toMatchObject({ accountId: "different-workspace" });
		expect(credential).not.toHaveProperty("verifiedIdentity");
	});

	it("logs in with the OpenAI Codex device code flow", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-05-20T00:00:00Z");
		vi.setSystemTime(startTime);

		const accessToken = createAccessToken("account-123");
		const deviceInfos: Array<{
			userCode: string;
			verificationUri: string;
			instructions?: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
		}> = [];
		const pollTimes: number[] = [];
		const pollResponses = [
			deviceAuthPendingResponse(),
			jsonResponse({
				authorization_code: "oauth-code",
				code_challenge: "device-code-challenge",
				code_verifier: "device-code-verifier",
			}),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
				expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
				return jsonResponse({
					device_auth_id: "device-auth-id",
					user_code: "ABCD-1234",
					interval: "5",
				});
			}

			if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
				pollTimes.push(Date.now());
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
				expect(JSON.parse(String(init?.body))).toEqual({
					device_auth_id: "device-auth-id",
					user_code: "ABCD-1234",
				});
				const response = pollResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra device auth poll");
				}
				return response;
			}

			if (url === "https://auth.openai.com/oauth/token") {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("authorization_code");
				expect(params.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
				expect(params.get("code")).toBe("oauth-code");
				expect(params.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
				expect(params.get("code_verifier")).toBe("device-code-verifier");
				return jsonResponse({
					access_token: accessToken,
					refresh_token: "refresh-token",
					expires_in: 3600,
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const credentialsPromise = loginChatGptSubscriptionDeviceCodeForTest({
			onDeviceCode: (info) => deviceInfos.push(info),
		});

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(deviceInfos).toEqual([
			{
				userCode: "ABCD-1234",
				verificationUri: "https://auth.openai.com/codex/device",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
		expect(pollTimes).toEqual([startTime.getTime()]);

		await vi.advanceTimersByTimeAsync(4999);
		expect(pollTimes).toEqual([startTime.getTime()]);

		await vi.advanceTimersByTimeAsync(1);
		const credential = await credentialsPromise;
		expect(credential).toMatchObject({
			access: accessToken,
			refresh: "refresh-token",
			expires: startTime.getTime() + 5000 + 3600 * 1000,
			accountId: "account-123",
		});
		expect(credential).not.toHaveProperty("verifiedIdentity");
		expect(pollTimes).toEqual([startTime.getTime(), startTime.getTime() + 5000]);
	});

	it("offers browser login first and uses the selected OpenAI Codex device code flow", async () => {
		const accessToken = createAccessToken("account-456");
		const selectPrompts: Array<{
			message: string;
			options: readonly { id: string; label: string }[];
		}> = [];
		const deviceInfos: Array<{
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
		}> = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "WXYZ-7890",
						interval: "5",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					return jsonResponse({
						authorization_code: "oauth-code",
						code_challenge: "device-code-challenge",
						code_verifier: "device-code-verifier",
					});
				}
				if (url === "https://auth.openai.com/oauth/token") {
					return jsonResponse({
						access_token: accessToken,
						refresh_token: "refresh-token",
						expires_in: 3600,
					});
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		await expect(
			chatgptSubscriptionOAuth.login({
				signal: neverAbortedSignal,
				prompt: async (prompt) => {
					if (prompt.type !== "select") throw new Error("Text prompt should not be used");
					selectPrompts.push(prompt);
					return "device_code";
				},
				notify: (event) => {
					if (event.type === "auth_url") throw new Error("Browser login should not start");
					if (event.type === "device_code") {
						const { type: _, ...info } = event;
						deviceInfos.push(info);
					}
				},
			}),
		).resolves.toMatchObject({
			type: "oauth",
			access: accessToken,
			refresh: "refresh-token",
			accountId: "account-456",
		});

		expect(selectPrompts).toEqual([
			{
				type: "select",
				message: "Select ChatGPT Subscription login method:",
				options: [
					{ id: "browser", label: "Browser login (default)" },
					{ id: "device_code", label: "Device code login (headless)" },
				],
			},
		]);
		expect(deviceInfos).toEqual([
			{
				userCode: "WXYZ-7890",
				verificationUri: "https://auth.openai.com/codex/device",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
	});

	it("cancels when OpenAI Codex login method selection is cancelled", async () => {
		await expect(
			chatgptSubscriptionOAuth.login({
				signal: neverAbortedSignal,
				prompt: async () => {
					throw new Error("Login cancelled");
				},
				notify: () => {},
			}),
		).rejects.toThrow("Login cancelled");
	});

	it("cancels the OpenAI Codex device code flow while waiting", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const pollTimes: number[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "5",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					pollTimes.push(Date.now());
					return deviceAuthPendingResponse();
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialsPromise = loginChatGptSubscriptionDeviceCodeForTest({
			onDeviceCode: () => {},
			signal: controller.signal,
		});
		const rejectionPromise = credentialsPromise.then(
			() => new Error("Expected login to fail"),
			(error: unknown) => error,
		);

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(pollTimes).toHaveLength(1);

		controller.abort();
		const rejection = await rejectionPromise;
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toBe("Login cancelled");
	});

	it("times out the OpenAI Codex device code flow after 15 minutes", async () => {
		vi.useFakeTimers();
		const pollTimes: number[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "60",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					pollTimes.push(Date.now());
					return deviceAuthPendingResponse();
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialsPromise = loginChatGptSubscriptionDeviceCodeForTest({
			onDeviceCode: () => {},
		});
		const rejectionPromise = credentialsPromise.then(
			() => new Error("Expected login to fail"),
			(error: unknown) => error,
		);

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(pollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
		const rejection = await rejectionPromise;
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toBe("Device flow timed out");
	});

	it("treats OpenAI Codex device auth 403 and 404 responses as pending", async () => {
		vi.useFakeTimers();
		const accessToken = createAccessToken("account-403-404");
		const pollTimes: number[] = [];
		const pollResponses = [
			jsonResponse({ error: "access_denied", error_description: "denied" }, 403),
			new Response("not ready", { status: 404, headers: { "Content-Type": "text/plain" } }),
			jsonResponse({
				authorization_code: "oauth-code",
				code_challenge: "device-code-challenge",
				code_verifier: "device-code-verifier",
			}),
		];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "1",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					pollTimes.push(Date.now());
					const response = pollResponses.shift();
					if (!response) {
						throw new Error("Unexpected extra device auth poll");
					}
					return response;
				}
				if (url === "https://auth.openai.com/oauth/token") {
					return jsonResponse({
						access_token: accessToken,
						refresh_token: "refresh-token",
						expires_in: 3600,
					});
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialsPromise = loginChatGptSubscriptionDeviceCodeForTest({
			onDeviceCode: () => {},
		});

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);

		await expect(credentialsPromise).resolves.toMatchObject({
			access: accessToken,
			refresh: "refresh-token",
			accountId: "account-403-404",
		});
		expect(pollTimes).toHaveLength(3);
	});

	it("preserves device auth failure status without exposing the response body", async () => {
		const tokenSentinel = "fake-device-token-sentinel";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "5",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					return jsonResponse({ error: "server_error", access_token: tokenSentinel }, 500);
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const error = await loginChatGptSubscriptionDeviceCodeForTest({ onDeviceCode: () => {} }).catch(
			(error: unknown) => error,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("status 500");
		expect((error as Error).message).not.toContain(tokenSentinel);
	});

	it("preserves token exchange failure status without exposing the response body", async () => {
		const tokenSentinel = "fake-exchange-token-sentinel";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = getUrl(input);
				if (url.endsWith("/usercode"))
					return jsonResponse({ device_auth_id: "device", user_code: "ABCD", interval: 0 });
				if (url.endsWith("/deviceauth/token"))
					return jsonResponse({ authorization_code: "code", code_verifier: "verifier" });
				if (url.endsWith("/oauth/token"))
					return jsonResponse({ error: "invalid_grant", refresh_token: tokenSentinel }, 401);
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const error = await loginChatGptSubscriptionDeviceCodeForTest({ onDeviceCode: () => {} }).catch(
			(error: unknown) => error,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("token exchange failed (401)");
		expect((error as Error).message).not.toContain(tokenSentinel);
	});

	it("does not include token fields in malformed exchange errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = getUrl(input);
				if (url.endsWith("/usercode"))
					return jsonResponse({ device_auth_id: "device", user_code: "ABCD", interval: 0 });
				if (url.endsWith("/deviceauth/token"))
					return jsonResponse({ authorization_code: "code", code_verifier: "verifier" });
				if (url.endsWith("/oauth/token"))
					return jsonResponse({ access_token: "secret-access", id_token: "secret-id" });
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const login = loginChatGptSubscriptionDeviceCodeForTest({ onDeviceCode: () => {} });

		await expect(login).rejects.not.toThrow(/secret-access|secret-id/);
	});

	it("preserves refresh failure status without exposing the response body or writing stderr", async () => {
		const tokenSentinel = "fake-refresh-token-sentinel";
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				return new Response(
					JSON.stringify({
						error: {
							message: `Could not validate ${tokenSentinel}`,
							type: "invalid_request_error",
						},
					}),
					{ status: 401, statusText: "Unauthorized", headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		const error = await chatgptSubscriptionOAuth
			.refresh(
				{
					type: "oauth",
					access: "invalid-access-token",
					refresh: "invalid-refresh-token",
					expires: 0,
				},
				neverAbortedSignal,
			)
			.catch((error: unknown) => error);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("token refresh failed (401)");
		expect((error as Error).message).not.toContain(tokenSentinel);
		expect(consoleError).not.toHaveBeenCalled();
	});
});
