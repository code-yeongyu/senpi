import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const DISCOVERY = "https://auth.openai.com/.well-known/openid-configuration";
const REVOCATION = "https://auth.openai.com/oauth/revoke";
const PROVIDER = "siwc-test";

async function connected() {
	const credentials = new InMemoryCredentialStore();
	const credential: OAuthCredential = {
		type: "oauth",
		access: "synthetic-access",
		refresh: "synthetic-refresh",
		expires: Date.now() + 3_600_000,
		clientId: "oaiapp_synthetic",
		idToken: "synthetic-id",
		hostId: "urn:uuid:e61bbe28-07ef-466d-8e5d-a344f94ab305",
	};
	await credentials.modify(PROVIDER, async () => credential);
	const models = createModels({ credentials });
	models.setProvider(
		createProvider({
			id: PROVIDER,
			auth: { oauth: openaiChatGPTOAuth },
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
