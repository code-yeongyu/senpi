import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as codexStream } from "../src/api/openai-codex-responses.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { appendLoginSlot, listSlots, mergeRefreshedSlot, projectSlot, removeSlot } from "../src/auth/pool/slots.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import type { Model } from "../src/types.ts";
import { createModels } from "../src/models.ts";
import { chatgptSubscriptionProvider } from "../src/providers/chatgpt-subscription.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const FUTURE = 4_102_444_800_000;
const context = {
	systemPrompt: "fixture instructions",
	messages: [{ role: "user" as const, content: "fixture message", timestamp: 1 }],
};

function credential(account: string, siwc = true): OAuthCredential {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } }),
	).toString("base64url");
	return {
		type: "oauth",
		access: `synthetic.${payload}.signature`,
		refresh: `synthetic-refresh-${account}`,
		expires: FUTURE,
		...(siwc
			? {
					route: "siwc",
					issuer: "https://auth.openai.com",
					subject: account,
					clientId: `oaiapp_${account}`,
					email: "same@example.test",
					idToken: `synthetic-id-${account}`,
					scopes: ["openid", "chatgpt.tokens.use.direct"],
					planUsageEnabled: true,
				}
			: {}),
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("ChatGPT credential placement (#5003 W11)", () => {
	it("preserves each SIWC registration through promotion, projection, refresh and removal", () => {
		const first = credential("first");
		const second = credential("second");
		const legacy = credential("legacy", false);
		const pool = appendLoginSlot(appendLoginSlot(first, second), legacy);
		expect(listSlots(pool)).toHaveLength(3);
		expect(projectSlot(pool, "login-2")).toEqual(second);
		expect(projectSlot(pool, "login-3")).toEqual(legacy);

		const rotated = {
			...second,
			access: "synthetic-rotated",
			refresh: "synthetic-rotated-refresh",
			scopes: ["openid"],
			planUsageEnabled: false,
		};
		const next = mergeRefreshedSlot(pool, "login-2", rotated);
		expect(projectSlot(next, "login-2")).toEqual(rotated);
		expect(projectSlot(next, "default")).toEqual(first);
		expect(projectSlot(next, "login-3")).toEqual(legacy);
		const survivor = removeSlot(removeSlot(next, "default"), "login-2");
		expect(projectSlot(survivor, "login-3")).toEqual(legacy);
		expect(survivor).not.toHaveProperty("route");
		expect(survivor).not.toHaveProperty("clientId");
	});

	it.each(["stream", "streamSimple"] as const)("sends SIWC through public Responses in Models.%s", async (method) => {
		const provider = chatgptSubscriptionProvider();
		const credentials = new InMemoryCredentialStore();
		const stored = credential("first");
		await credentials.modify(provider.id, async () => stored);
		const models = createModels({ credentials });
		models.setProvider(provider);
		const model = provider.getModels().find((candidate) => candidate.id === "gpt-6.1-sol-fast")!;
		const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
		const fetchStub: typeof fetch = async (input, init) => {
			requests.push({
				url: input instanceof Request ? input.url : String(input),
				headers: new Headers(init?.headers),
				body: typeof init?.body === "string" ? JSON.parse(init.body) : {},
			});
			return new Response(
				'data: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[]}}\n\n',
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		};
		vi.stubGlobal("fetch", fetchStub);
		const result = await models[method](model, context, {
			fetch: fetchStub,
			transport: "sse",
			maxRetries: 0,
			temperature: 0.5,
			maxTokens: 128,
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe("https://api.openai.com/v1/responses");
		expect(requests[0].headers.get("authorization")).toBe(`Bearer ${stored.access}`);
		expect(requests[0].headers.has("chatgpt-account-id")).toBe(false);
		expect(requests[0].body).toMatchObject({ model: "gpt-6.1-sol", store: false, stream: true });
		expect(requests[0].body).not.toHaveProperty("temperature");
		expect(requests[0].body).not.toHaveProperty("max_output_tokens");
		expect(requests[0].body.input).toContainEqual({ role: "developer", content: "fixture instructions" });
		expect(model.api).toBe("openai-codex-responses");
		expect(model.baseUrl).toBe("https://chatgpt.com/backend-api");
	});

	it("refreshes the selected SIWC registration and merges its replacement scopes without changing siblings", async () => {
		const provider = chatgptSubscriptionProvider();
		const credentials = new InMemoryCredentialStore();
		const first = credential("first");
		const second = { ...credential("second"), expires: 0 };
		await credentials.modify(provider.id, async () => appendLoginSlot(first, second));
		const models = createModels({ credentials });
		models.setProvider(provider);
		const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe("https://auth.openai.com/api/accounts/oauth/token");
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("client_id")).toBe("oaiapp_second");
			expect(body.get("refresh_token")).toBe(second.refresh);
			return Response.json({
				access_token: "synthetic-new-access",
				refresh_token: "synthetic-new-refresh",
				expires_in: 3600,
				scope: "resource.invoke chatgpt.tokens.use.direct",
			});
		});
		vi.stubGlobal("fetch", fetchStub);
		const resolved = await models.getAuth(provider.id, { slotName: "login-2" });
		expect(resolved?.auth).toMatchObject({
			apiKey: "synthetic-new-access",
			api: "openai-responses",
			compat: { siwc: true },
		});
		const saved = await credentials.read(provider.id);
		expect(projectSlot(saved, "default")).toEqual(first);
		expect(projectSlot(saved, "login-2")).toMatchObject({
			route: "siwc",
			issuer: "https://auth.openai.com",
			subject: "second",
			clientId: "oaiapp_second",
			idToken: "synthetic-id-second",
			refresh: "synthetic-new-refresh",
			scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
		});
		expect(fetchStub).toHaveBeenCalledTimes(1);
	});

	it("keeps legacy request URL, headers and serialized body identical to the Codex adapter", async () => {
		const provider = chatgptSubscriptionProvider();
		const credentials = new InMemoryCredentialStore();
		const stored = credential("legacy", false);
		await credentials.modify(provider.id, async () => stored);
		const models = createModels({ credentials });
		models.setProvider(provider);
		const found = provider.getModels().find((candidate) => candidate.id === "gpt-6.1-sol");
		if (found?.api !== "openai-codex-responses") throw new Error("fixture model is not on the Codex route");
		const model = found as Model<"openai-codex-responses">;
		const requests: { url: string; headers: Record<string, string>; body: RequestInit["body"] }[] = [];
		const fetchStub: typeof fetch = async (input, init) => {
			requests.push({
				url: input instanceof Request ? input.url : String(input),
				headers: Object.fromEntries(new Headers(init?.headers)),
				body: init?.body,
			});
			return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n', {
				headers: { "content-type": "text/event-stream" },
			});
		};
		vi.stubGlobal("fetch", fetchStub);
		const options = { fetch: fetchStub, transport: "sse" as const, sessionId: "fixture-session", maxRetries: 0 };
		const before = await codexStream(model, normalizeContext(context), {
			...options,
			apiKey: stored.access,
		}).result();
		const after = await models.stream(model, context, options).result();
		expect(before.stopReason, before.errorMessage).toBe("stop");
		expect(after.stopReason, after.errorMessage).toBe("stop");
		expect(requests).toHaveLength(2);
		expect(requests[1]).toEqual(requests[0]);
		expect(requests[1].url).toBe("https://chatgpt.com/backend-api/codex/responses");
	});
});
