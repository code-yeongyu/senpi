import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import type { OAuthAuth, OAuthCredential } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const DISCOVERY = "https://auth.openai.com/.well-known/openid-configuration";
const REVOCATION = "https://auth.openai.com/oauth/revoke";
const PROVIDER = "siwc-test";

async function connected(oauth: OAuthAuth = openaiChatGPTOAuth) {
	const credentials = new InMemoryCredentialStore();
	const credential: OAuthCredential = {
		type: "oauth",
		access: "synthetic-access",
		refresh: "synthetic-refresh",
		expires: Date.now() + 3_600_000,
		clientId: "oaiapp_synthetic",
		idToken: "synthetic-id",
		hostId: "urn:uuid:e61bbe28-07ef-466d-8e5d-a344f94ab305",
		scopes: ["chatgpt.tokens.use.direct"],
	};
	await credentials.modify(PROVIDER, async () => credential);
	const models = createModels({ credentials });
	models.setProvider(
		createProvider({
			id: PROVIDER,
			auth: { oauth },
			models: [],
			api: {
				stream: () => {
					throw new Error("Not used");
				},
				streamSimple: () => {
					throw new Error("Not used");
				},
			},
		}),
	);
	return { models, credentials, credential };
}

function endpoint(revoke: (init?: RequestInit) => Response | Promise<Response>) {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === DISCOVERY) return Response.json({ revocation_endpoint: REVOCATION });
		expect(url).toBe(REVOCATION);
		return revoke(init);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("SIWC storage logout (#5003 W7)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each([200, 400])("does not resurrect a refresh racing logout (rotated revoke HTTP %i)", async (status) => {
		const refreshing = Promise.withResolvers<void>();
		const rotated = Promise.withResolvers<OAuthCredential>();
		const originalRevoked = Promise.withResolvers<void>();
		const { models, credentials, credential } = await connected({
			...openaiChatGPTOAuth,
			revoke: async (target, options) => {
				const result = await openaiChatGPTOAuth.revoke?.(target, options);
				if (!result) throw new Error("Missing test revocation hook");
				if (target.refresh === "synthetic-refresh") originalRevoked.resolve();
				return result;
			},
			refresh: async () => {
				refreshing.resolve();
				return rotated.promise;
			},
		});
		await credentials.modify(PROVIDER, async () => ({ ...credential, expires: 0 }));
		const revoking = Promise.withResolvers<void>();
		const response = Promise.withResolvers<Response>();
		const posted: string[] = [];
		endpoint((init) => {
			const token = new URLSearchParams(String(init?.body)).get("token") ?? "";
			posted.push(token);
			if (token === credential.refresh) {
				revoking.resolve();
				return response.promise;
			}
			return new Response(null, { status });
		});

		// Reviewer's sequence: exchange starts, logout starts, rotation finishes,
		// then the original token's revocation completes. No network or sleeps.
		const auth = models.getAuth(PROVIDER);
		await refreshing.promise;
		const logout = models.logout(PROVIDER);
		await revoking.promise;
		if (status === 400) {
			// Also prove logout includes a rotation that arrives after the original revoke.
			response.resolve(new Response(null, { status: 200 }));
			await originalRevoked.promise;
		}
		rotated.resolve({
			...credential,
			access: "rotated-access",
			refresh: "rotated-refresh",
			idToken: "rotated-id",
			expires: Date.now() + 3_600_000,
		});
		await auth.catch(() => undefined);
		response.resolve(new Response(null, { status: 200 }));
		expect.soft(await logout).toEqual({
			status: status === 200 ? "revoked" : "remote_revocation_unconfirmed",
		});
		expect.soft(await credentials.read(PROVIDER)).toMatchObject({ access: "", refresh: "", expires: 0 });
		expect.soft(await credentials.read(PROVIDER)).not.toHaveProperty("idToken");
		expect.soft(await models.getAuth(PROVIDER)).toBeUndefined();
		expect.soft(posted).toEqual([credential.refresh, "rotated-refresh"]);
	});

	it("includes refresh admitted while a shared store is publishing the clear", async () => {
		const refreshing = Promise.withResolvers<void>();
		const rotated = Promise.withResolvers<OAuthCredential>();
		const { models, credentials, credential } = await connected({
			...openaiChatGPTOAuth,
			refresh: async () => {
				refreshing.resolve();
				return rotated.promise;
			},
		});
		await credentials.modify(PROVIDER, async () => ({ ...credential, expires: 0 }));
		const peer = createModels({ credentials });
		const provider = models.getProvider(PROVIDER);
		if (!provider) throw new Error("Missing test provider");
		peer.setProvider(provider);
		const prepared = Promise.withResolvers<void>();
		const publish = Promise.withResolvers<void>();
		const modify = credentials.modify.bind(credentials);
		vi.spyOn(credentials, "modify").mockImplementationOnce((id, fn, options) =>
			modify(
				id,
				async (current) => {
					const next = await fn(current);
					prepared.resolve();
					await publish.promise;
					return next;
				},
				options,
			),
		);
		const revoking = Promise.withResolvers<void>();
		const response = Promise.withResolvers<Response>();
		const posted: string[] = [];
		endpoint((init) => {
			const token = new URLSearchParams(String(init?.body)).get("token") ?? "";
			posted.push(token);
			if (token === credential.refresh) {
				revoking.resolve();
				return response.promise;
			}
			return new Response(null, { status: 400 });
		});
		const logout = models.logout(PROVIDER);
		await prepared.promise;
		const auth = peer.getAuth(PROVIDER).catch(() => undefined);
		await refreshing.promise;
		publish.resolve();
		await revoking.promise;
		rotated.resolve({ ...credential, access: "rotated-access", refresh: "rotated-refresh" });
		await auth;
		response.resolve(new Response(null, { status: 200 }));
		expect(await logout).toEqual({ status: "remote_revocation_unconfirmed" });
		expect(posted).toEqual([credential.refresh, "rotated-refresh"]);
		expect(await credentials.read(PROVIDER)).toMatchObject({ access: "", refresh: "" });
		expect(await models.getAuth(PROVIDER)).toBeUndefined();
	});

	it("keeps auth blocked until both overlapping slot logouts finish", async () => {
		const { models, credentials, credential } = await connected();
		await credentials.modify(PROVIDER, async () => ({
			...credential,
			accounts: ["first", "second", "survivor"].map((name) => ({
				...credential,
				name,
				access: `${name}-access`,
				refresh: `${name}-refresh`,
			})),
		}));
		const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const responses = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
		endpoint((init) => {
			const token = new URLSearchParams(String(init?.body)).get("token");
			const index = token === "first-refresh" ? 0 : 1;
			started[index].resolve();
			return responses[index].promise;
		});
		const first = models.logout(PROVIDER, { slotId: "first" });
		await started[0].promise;
		const second = models.logout(PROVIDER, { slotId: "second" });
		await started[1].promise;
		responses[0].resolve(new Response(null, { status: 200 }));
		await first;
		const during = await models.getAuth(PROVIDER, { slotName: "survivor" });
		responses[1].resolve(new Response(null, { status: 200 }));
		await second;
		expect(during).toBeUndefined();
		expect(await models.getAuth(PROVIDER, { slotName: "survivor" })).toMatchObject({
			auth: { apiKey: "survivor-access" },
		});
	});

	it("does not confirm revocation for an unknown slot", async () => {
		const { models, credentials, credential } = await connected();
		const fetchMock = endpoint(() => new Response(null, { status: 200 }));
		expect(await models.logout(PROVIDER, { slotId: "missing" })).toEqual({
			status: "remote_revocation_unconfirmed",
		});
		expect(await credentials.read(PROVIDER)).toEqual(credential);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("revokes once with the issued client ID then clears tokens but retains registration", async () => {
		const { models, credentials, credential } = await connected();
		const revoke = vi.fn((init?: RequestInit) => {
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
			expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
				token: credential.refresh,
				token_type_hint: "refresh_token",
				client_id: credential.clientId,
			});
			return new Response(null, { status: 200 });
		});
		endpoint(revoke);

		expect(await models.logout(PROVIDER)).toEqual({ status: "revoked" });
		expect(revoke).toHaveBeenCalledTimes(1);
		const stored = await credentials.read(PROVIDER);
		expect(stored).toMatchObject({ clientId: credential.clientId, hostId: credential.hostId });
		expect(stored).toMatchObject({ access: "", refresh: "", expires: 0 });
		expect(stored).not.toHaveProperty("idToken");
		expect(await models.getAuth(PROVIDER)).toBeUndefined();
		expect(revoke).toHaveBeenCalledTimes(1);
	});

	it("signs back in after logout: the new login replaces the signed-out registration", async () => {
		const { models, credentials, credential } = await connected({
			...openaiChatGPTOAuth,
			login: async () => ({
				...credential,
				access: "again-access",
				refresh: "again-refresh",
				expires: Date.now() + 3_600_000,
			}),
		});
		endpoint(() => new Response(null, { status: 200 }));

		expect(await models.logout(PROVIDER)).toEqual({ status: "revoked" });
		await models.login(PROVIDER, "oauth", {} as Parameters<typeof models.login>[2]);
		const stored = await credentials.read(PROVIDER);
		expect(stored).toMatchObject({ access: "again-access", refresh: "again-refresh", clientId: credential.clientId });
		expect(stored).not.toHaveProperty("signedOut");
		expect(stored).not.toHaveProperty("accounts");
		expect(await models.getAuth(PROVIDER)).toBeDefined();
	});

	it("signs back in after a pooled logout: the new login becomes the resolved account", async () => {
		const { models, credentials, credential } = await connected({
			...openaiChatGPTOAuth,
			login: async () => ({ ...credential, access: "again-access", refresh: "again-refresh" }),
		});
		await credentials.modify(PROVIDER, async () => ({
			...credential,
			accounts: [{ ...credential, name: "first" }],
		}));
		endpoint(() => new Response(null, { status: 200 }));

		expect(await models.logout(PROVIDER)).toEqual({ status: "revoked" });
		await models.login(PROVIDER, "oauth", {} as Parameters<typeof models.login>[2]);
		const stored = await credentials.read(PROVIDER);
		expect(stored).toMatchObject({ access: "again-access", refresh: "again-refresh" });
		expect(stored).not.toHaveProperty("signedOut");
		if (stored?.type !== "oauth" || !Array.isArray(stored.accounts)) throw new Error("Missing pool");
		expect(stored.accounts).toMatchObject([
			{ name: "first", access: "", refresh: "" },
			{ access: "again-access", refresh: "again-refresh" },
		]);
		expect(await models.getAuth(PROVIDER)).toBeDefined();
	});

	it("retries 503 then accepts an empty 200, including an already-invalid refresh token", async () => {
		const { models, credentials } = await connected();
		const sleep = vi.fn(async (_milliseconds: number) => {});
		const revoke = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		endpoint(revoke);

		expect(await models.logout(PROVIDER, { sleep })).toEqual({ status: "revoked" });
		expect(revoke).toHaveBeenCalledTimes(2);
		expect(sleep.mock.calls).toEqual([[250]]);
		expect(await credentials.read(PROVIDER)).toMatchObject({ refresh: "", clientId: "oaiapp_synthetic" });
	});

	it("bounds network retries and clears locally with a typed unconfirmed result", async () => {
		const { models, credentials } = await connected();
		const sleep = vi.fn(async (_milliseconds: number) => {});
		const revoke = vi.fn().mockRejectedValue(new TypeError("synthetic network failure"));
		endpoint(revoke);

		expect(await models.logout(PROVIDER, { sleep })).toEqual({ status: "remote_revocation_unconfirmed" });
		expect(revoke).toHaveBeenCalledTimes(3);
		expect(sleep.mock.calls).toEqual([[250], [1000]]);
		expect(await credentials.read(PROVIDER)).toMatchObject({ access: "", refresh: "", clientId: "oaiapp_synthetic" });
		expect(await models.getAuth(PROVIDER)).toBeUndefined();
	});

	it("does not retry a permanent revocation rejection", async () => {
		const { models, credentials } = await connected();
		const revoke = vi.fn(() => new Response(null, { status: 400 }));
		endpoint(revoke);
		expect(await models.logout(PROVIDER)).toEqual({ status: "remote_revocation_unconfirmed" });
		expect(revoke).toHaveBeenCalledTimes(1);
		expect(await credentials.read(PROVIDER)).toMatchObject({ access: "", refresh: "" });
	});

	it("blocks new auth while revoking and leaves a concurrent new login intact", async () => {
		const { models, credentials, credential } = await connected();
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<Response>();
		endpoint(() => {
			started.resolve();
			return response.promise;
		});
		const logout = models.logout(PROVIDER);
		await started.promise;
		expect(await models.getAuth(PROVIDER)).toBeUndefined();
		await credentials.modify(PROVIDER, async () => ({
			...credential,
			access: "new-access",
			refresh: "new-refresh",
		}));
		response.resolve(new Response(null, { status: 200 }));
		await logout;
		expect(await credentials.read(PROVIDER)).toMatchObject({ access: "new-access", refresh: "new-refresh" });
	});

	it("clears locally if discovery cannot be reached", async () => {
		const { models, credentials } = await connected();
		const fetchMock = vi.fn().mockRejectedValue(new TypeError("synthetic discovery failure"));
		vi.stubGlobal("fetch", fetchMock);
		expect(await models.logout(PROVIDER, { sleep: async () => {} })).toEqual({
			status: "remote_revocation_unconfirmed",
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(await credentials.read(PROVIDER)).toMatchObject({ access: "", refresh: "", clientId: "oaiapp_synthetic" });
	});

	it("aborts an active request before sending the revocation POST", async () => {
		const { models } = await connected();
		const model: Model<Api> = {
			id: "synthetic-model",
			name: "synthetic-model",
			provider: PROVIDER,
			api: "openai-responses",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			contextWindow: 1000,
			maxTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const started = Promise.withResolvers<AbortSignal>();
		const provider = models.getProvider(PROVIDER);
		if (!provider) throw new Error("Missing test provider");
		models.setProvider({
			...provider,
			stream: (_model, _context, options) => {
				const stream = new AssistantMessageEventStream();
				if (!options?.signal) throw new Error("Missing request cancellation signal");
				options.signal.addEventListener("abort", () => stream.end(), { once: true });
				started.resolve(options.signal);
				return stream;
			},
		});
		models.stream(model, { messages: [] });
		const requestSignal = await started.promise;
		endpoint(() => {
			expect(requestSignal.aborted).toBe(true);
			return new Response(null, { status: 200 });
		});
		expect(await models.logout(PROVIDER)).toEqual({ status: "revoked" });
	});

	it("still deletes an API key stored on a provider with an optional revoke hook", async () => {
		const { models, credentials } = await connected();
		await credentials.modify(PROVIDER, async () => ({ type: "api_key", key: "synthetic-key" }));
		const fetchMock = endpoint(() => new Response(null, { status: 200 }));
		await models.logout(PROVIDER);
		expect(await credentials.read(PROVIDER)).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not refresh a stale read after logout has cleared the stored session", async () => {
		const { models, credentials, credential } = await connected();
		await credentials.modify(PROVIDER, async () => ({ ...credential, expires: 0 }));
		const read = credentials.read.bind(credentials);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(credentials, "read").mockImplementationOnce(async (providerId) => {
			const stale = await read(providerId);
			started.resolve();
			await release.promise;
			return stale;
		});
		const fetchMock = endpoint(() => new Response(null, { status: 200 }));
		const auth = models.getAuth(PROVIDER);
		await started.promise;
		await models.logout(PROVIDER);
		release.resolve();
		expect(await auth).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("clears only the selected account and preserves each issued client mapping", async () => {
		const { models, credentials, credential } = await connected();
		await credentials.modify(PROVIDER, async () => ({
			...credential,
			accounts: [
				{ ...credential, name: "first" },
				{
					...credential,
					name: "second",
					clientId: "oaiapp_second",
					access: "second-access",
					refresh: "second-refresh",
					idToken: "second-id",
				},
			],
		}));
		const revoke = vi.fn((init?: RequestInit) => {
			expect(new URLSearchParams(String(init?.body)).get("client_id")).toBe("oaiapp_synthetic");
			return new Response(null, { status: 200 });
		});
		endpoint(revoke);
		expect(await models.logout(PROVIDER, { slotId: "first" })).toEqual({ status: "revoked" });
		const stored = await credentials.read(PROVIDER);
		expect(stored).toMatchObject({
			clientId: "oaiapp_second",
			access: "second-access",
			refresh: "second-refresh",
			idToken: "second-id",
			accounts: [
				{ name: "first", clientId: "oaiapp_synthetic", access: "", refresh: "" },
				{
					name: "second",
					clientId: "oaiapp_second",
					access: "second-access",
					refresh: "second-refresh",
					idToken: "second-id",
				},
			],
		});
		if (stored?.type !== "oauth" || !Array.isArray(stored.accounts))
			throw new Error("Missing retained registrations");
		expect(stored.accounts[0]).not.toHaveProperty("idToken");
		expect(await models.getAuth(PROVIDER, { slotName: "first" })).toBeUndefined();
		expect(revoke).toHaveBeenCalledTimes(1);
	});
});
