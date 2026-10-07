import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent, AssistantMessageEventStream, Credential } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

// Issue #2297: GitHub revoked short-lived Copilot tokens server-side while senpi
// still believed they had ~22h left (Copilot tokens now live 24h). Every request
// on the revoked token got HTTP 403 with an empty body, and senpi never
// re-exchanged it because refresh is expiry-driven. VS Code Copilot Chat drops
// its Copilot token on 401/403 and fetches a new one; senpi must do the same,
// once, before any output reaches the caller.

const API = "https://api.individual.githubcopilot.com";
const TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const HOURS = 60 * 60 * 1000;
const REVOKED = `tid=revoked;exp=${Math.floor((Date.now() + 22 * HOURS) / 1000)};proxy-ep=proxy.individual.githubcopilot.com`;
const FRESH = `tid=fresh;exp=${Math.floor((Date.now() + 24 * HOURS) / 1000)};proxy-ep=proxy.individual.githubcopilot.com`;

type Call = { url: string; auth: string | null };

let dir: string;
let calls: Call[];

function sse(): Response {
	const chunk = (delta: Record<string, unknown>, finish: string | null) =>
		`data: ${JSON.stringify({
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "kimi-k3",
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`;
	const body = `${chunk({ role: "assistant", content: "OK" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fakeCopilot(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const url = input instanceof Request ? input.url : String(input);
	const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
	const auth = headers.get("authorization");
	calls.push({ url, auth });
	if (url === TOKEN_URL) {
		return Promise.resolve(
			Response.json({ token: FRESH, expires_at: Math.floor((Date.now() + 24 * HOURS) / 1000), refresh_in: 86340 }),
		);
	}
	if (url === `${API}/models`) {
		return Promise.resolve(
			Response.json({
				data: [{ id: "kimi-k3", model_picker_enabled: true, policy: { state: "enabled" }, capabilities: {} }],
			}),
		);
	}
	if (url === `${API}/chat/completions`) {
		if (auth === `Bearer ${FRESH}`) return Promise.resolve(sse());
		return Promise.resolve(
			new Response("", { status: 403, headers: { "x-github-request-id": "C6FD:AB660:AEB5548:CC3FDF2:6ABA4D81" } }),
		);
	}
	return Promise.resolve(new Response("unexpected", { status: 599 }));
}

async function runtimeWith(credential: Credential): Promise<{ runtime: ModelRuntime; credentials: AuthStorage }> {
	const credentials = AuthStorage.inMemory();
	await credentials.modify("github-copilot", async () => credential);
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		agentDir: dir,
		allowModelNetwork: false,
	});
	return { runtime, credentials };
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		if (event.type === "done" || event.type === "error") break;
	}
	return events;
}

const context = { messages: [{ role: "user" as const, content: "Reply with OK.", timestamp: 0 }], tools: [] };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "issue-2297-"));
	calls = [];
	vi.stubGlobal("fetch", vi.fn(fakeCopilot));
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

describe("issue #2297: a Copilot token GitHub refuses is re-exchanged once", () => {
	it("recovers a single-account request from a server-revoked cached token", async () => {
		const { runtime, credentials } = await runtimeWith({
			type: "oauth",
			access: REVOKED,
			refresh: "gho_test_refresh_default",
			expires: Date.now() + 22 * HOURS,
		});

		const events = await collect(runtime.stream(getModel("github-copilot", "kimi-k3"), context, {}));

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("done");
		const inference = calls.filter((call) => call.url === `${API}/chat/completions`);
		expect(inference.map((call) => call.auth)).toEqual([`Bearer ${REVOKED}`, `Bearer ${FRESH}`]);
		expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(1);
		const stored = await credentials.read("github-copilot");
		expect(stored?.type === "oauth" ? stored.access : undefined).toBe(FRESH);
	});

	it("heals the pinned pool slot instead of leaving the session on a dead token", async () => {
		const { runtime, credentials } = await runtimeWith({
			type: "oauth",
			access: REVOKED,
			refresh: "gho_test_refresh_default",
			expires: Date.now() + 22 * HOURS,
			pinned: "default",
			accounts: [
				{
					name: "default",
					source: "login",
					access: REVOKED,
					refresh: "gho_test_refresh_default",
					expires: Date.now() + 22 * HOURS,
				},
				{
					name: "login-2",
					source: "login",
					access: FRESH,
					refresh: "gho_test_refresh_second",
					expires: Date.now() + 23 * HOURS,
				},
			],
		} as Credential);

		const events = await collect(
			runtime.stream(getModel("github-copilot", "kimi-k3"), context, { sessionId: "long-running-session" }),
		);

		expect(events.at(-1)?.type).toBe("done");
		const exchanges = calls.filter((call) => call.url === TOKEN_URL);
		expect(exchanges.map((call) => call.auth)).toEqual(["Bearer gho_test_refresh_default"]);
		const stored = (await credentials.read("github-copilot")) as { accounts?: { name: string; access?: string }[] };
		expect(stored.accounts?.find((slot) => slot.name === "default")?.access).toBe(FRESH);
	});

	it("fails over to a healthy account when the re-exchanged token is refused too", async () => {
		const stillRefused = `tid=still-refused;exp=${Math.floor((Date.now() + 24 * HOURS) / 1000)};proxy-ep=proxy.individual.githubcopilot.com`;
		vi.stubGlobal(
			"fetch",
			vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url === TOKEN_URL) {
					calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
					return Promise.resolve(
						Response.json({ token: stillRefused, expires_at: Math.floor((Date.now() + 24 * HOURS) / 1000) }),
					);
				}
				return fakeCopilot(input, init);
			}),
		);
		const { runtime } = await runtimeWith({
			type: "oauth",
			access: REVOKED,
			refresh: "gho_test_refresh_default",
			expires: Date.now() + 22 * HOURS,
			pinned: "default",
			accounts: [
				{
					name: "default",
					source: "login",
					access: REVOKED,
					refresh: "gho_test_refresh_default",
					expires: Date.now() + 22 * HOURS,
				},
				{
					name: "login-2",
					source: "login",
					access: FRESH,
					refresh: "gho_test_refresh_second",
					expires: Date.now() + 23 * HOURS,
				},
			],
		} as Credential);

		const events = await collect(
			runtime.stream(getModel("github-copilot", "kimi-k3"), context, { sessionId: "long-running-session" }),
		);

		expect(events.at(-1)?.type).toBe("done");
		const inference = calls.filter((call) => call.url === `${API}/chat/completions`);
		expect(inference.map((call) => call.auth)).toEqual([
			`Bearer ${REVOKED}`,
			`Bearer ${stillRefused}`,
			`Bearer ${FRESH}`,
		]);
		const pool = (await Reflect.get(runtime, "loadCredentialPool").call(runtime)).repository as {
			listSlots(providerId: string, lane: "stored"): Promise<Record<string, { blockReason?: string }>>;
		};
		expect((await pool.listSlots("github-copilot", "stored")).default?.blockReason).toBe("auth_error");
	});

	it("re-exchanges at most once when the fresh token is refused too", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url === `${API}/chat/completions`) {
					calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
					return Promise.resolve(
						new Response("", { status: 403, headers: { "x-github-request-id": "ABCD:0001" } }),
					);
				}
				return fakeCopilot(input, init);
			}),
		);
		const { runtime } = await runtimeWith({
			type: "oauth",
			access: REVOKED,
			refresh: "gho_test_refresh_default",
			expires: Date.now() + 22 * HOURS,
		});

		const events = await collect(runtime.stream(getModel("github-copilot", "kimi-k3"), context, {}));

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		expect(calls.filter((call) => call.url === `${API}/chat/completions`)).toHaveLength(2);
		expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(1);
		const message = terminal?.type === "error" ? (terminal.error.errorMessage ?? "") : "";
		expect(message).toContain("GitHub Copilot refused the request (HTTP 403");
		expect(message).toContain("ABCD:0001");
	});
});
