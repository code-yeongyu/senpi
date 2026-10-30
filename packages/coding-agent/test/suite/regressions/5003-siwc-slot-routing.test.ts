import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEventStream, OAuthCredential } from "@earendil-works/pi-ai";
import { appendLoginSlot, type PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import { addOpenAiWebSearchToPayload } from "../../../src/core/extensions/builtin/openai-web-search/index.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

let directory: string;
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

async function finish(stream: AssistantMessageEventStream) {
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") {
			expect(event.type, event.type === "error" ? event.error.errorMessage : undefined).toBe("done");
			break;
		}
	}
}

// #5003: actual pool selection and both real adapters, with only HTTP replaced.
it.each(["stream", "streamSimple"] as const)("routes a mixed pool per selected slot in %s and retains readable health", async (method) => {
	vi.stubEnv("PI_OPENAI_WEB_SEARCH", "");
	directory = mkdtempSync(join(tmpdir(), "siwc-placement-"));
	const account = (name: string, siwc: boolean): OAuthCredential => ({
		type: "oauth",
		access: `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: name } })).toString("base64url")}.signature`,
		refresh: `synthetic-refresh-${name}`,
		expires: 4_102_444_800_000,
		...(siwc ? { route: "siwc", issuer: "https://auth.openai.com", subject: name, clientId: `oaiapp_${name}`, scopes: ["chatgpt.tokens.use.direct"] } : {}),
	});
	const first = account("first", true);
	const second = account("second", true);
	const legacy = account("legacy", false);
	const pool = appendLoginSlot(appendLoginSlot(first, second), legacy);
	const credentials = AuthStorage.inMemory({ "chatgpt-subscription": pool });
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, agentDir: directory, allowModelNetwork: false });
	const model = runtime.getProvider("chatgpt-subscription")!.getModels().find((candidate) => candidate.id === "gpt-6.1-sol")!;
	// Prewarm and other prepared-request callers must see the same route restrictions.
	const prepared = await runtime.prepareSimpleRequest(model);
	expect(prepared.model).toMatchObject({
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		compat: { siwc: true },
	});
	const requests: { url: string; token: string | null; body: string }[] = [];
	let rejectFirst = false;
	const fetchStub: typeof fetch = async (input, init) => {
		requests.push({ url: input instanceof Request ? input.url : String(input), token: new Headers(init?.headers).get("authorization"), body: String(init?.body) });
		if (rejectFirst && requests.at(-1)?.token === `Bearer ${first.access}`) {
			return Response.json({ error: { message: "Unauthorized", code: "invalid_api_key" } }, { status: 401 });
		}
		return new Response('data: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[]}}\n\n', { headers: { "content-type": "text/event-stream" } });
	};
	vi.stubGlobal("fetch", fetchStub);
	for (const name of ["default", "login-2", "login-3"]) {
		await credentials.modify(model.provider, async (current) => ({ ...current!, pinned: name }));
		await finish(runtime[method](model, { systemPrompt: "instructions", messages: [{ role: "user", content: "fixture", timestamp: 1 }] }, {
			fetch: fetchStub, transport: "sse", maxRetries: 0, temperature: 0.5,
			onPayload: (payload, requestModel) => addOpenAiWebSearchToPayload(requestModel, payload),
		}));
	}
	expect(requests.map(({ url, token }) => ({ url, token }))).toEqual([
		{ url: "https://api.openai.com/v1/responses", token: `Bearer ${first.access}` },
		{ url: "https://api.openai.com/v1/responses", token: `Bearer ${second.access}` },
		{ url: "https://chatgpt.com/backend-api/codex/responses", token: `Bearer ${legacy.access}` },
	]);
	for (const request of requests.slice(0, 2)) {
		const body = JSON.parse(request.body);
		expect(body).toMatchObject({ store: false, stream: true });
		expect(body).not.toHaveProperty("temperature");
		expect(body.input).toContainEqual({ role: "developer", content: "instructions" });
		expect(body.tools).toContainEqual({ type: "web_search" });
	}
	expect((await credentials.read(model.provider) as PooledCredential).accounts).toHaveLength(3);
	const path = join(directory, "credential-pool-state.json");
	const raw = JSON.parse(readFileSync(path, "utf8"));
	const reread = await new CredentialSlotRepository(path).listSlots(model.provider, "stored");
	expect(reread).toEqual(raw.providers[model.provider].lanes.stored.slots);
	requests.length = 0;
	rejectFirst = true;
	await credentials.modify(model.provider, async (current) => ({
		...current!,
		pinned: "default",
		order: ["login-2", "login-3"],
	}));
	await finish(runtime[method](model, { messages: [{ role: "user", content: "fallback fixture", timestamp: 2 }] }, { fetch: fetchStub, transport: "sse", maxRetries: 0 }));
	expect(requests.map((request) => request.token)).toEqual([`Bearer ${first.access}`, `Bearer ${second.access}`]);
	expect(requests.every((request) => request.url === "https://api.openai.com/v1/responses")).toBe(true);
	const afterFallback = await new CredentialSlotRepository(path).listSlots(model.provider, "stored");
	expect(afterFallback).toEqual(JSON.parse(readFileSync(path, "utf8")).providers[model.provider].lanes.stored.slots);
	expect(afterFallback.default.blockReason).toBe("auth_error");
	expect(afterFallback["login-2"]?.blockReason).toBeUndefined();
});
