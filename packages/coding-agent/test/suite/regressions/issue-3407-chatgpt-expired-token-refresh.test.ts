import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent, AssistantMessageEventStream, Credential } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

// Issue #3407: ChatGPT refuses a stored access token with HTTP 401 "Your authentication
// token has expired. Please try refreshing it." while the stored `expires` still says it is
// valid, so senpi's expiry-driven refresh never runs and every turn fails as "the provider
// rejected the credentials" until the user signs in again (a desktop user hit it on a fresh
// thread with a full weekly quota). The stored refresh token still works: senpi must
// refresh once and retry, and say "sign in again" only when that refresh itself fails.

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const HOURS = 60 * 60 * 1000;
const EXPIRED_BODY = JSON.stringify({
	error: {
		message: "Your authentication token has expired. Please try refreshing it.",
		type: "invalid_request_error",
		code: "token_expired",
		param: null,
	},
});

function token(tag: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" }, tag }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

const SERVER_EXPIRED = token("server-expired");
const FRESH = token("fresh");

type Call = { url: string; auth: string | null; body?: string };
let dir: string;
let calls: Call[];

function completedSSE(): Response {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "OK" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "OK" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_3407",
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fakeChatGpt(refresh: () => Response, refusalBody = EXPIRED_BODY) {
	return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = input instanceof Request ? input.url : String(input);
		const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
		const auth = headers.get("authorization");
		calls.push({
			url,
			auth,
			...(typeof init?.body === "string" || init?.body instanceof URLSearchParams
				? { body: String(init.body) }
				: {}),
		});
		if (url === TOKEN_URL) return Promise.resolve(refresh());
		if (url === ENDPOINT) {
			if (auth === `Bearer ${FRESH}`) return Promise.resolve(completedSSE());
			return Promise.resolve(
				new Response(refusalBody, { status: 401, headers: { "content-type": "application/json" } }),
			);
		}
		return Promise.resolve(new Response("unexpected", { status: 599 }));
	};
}

const refreshes = () => Response.json({ access_token: FRESH, refresh_token: "rt_rotated", expires_in: 864000 });
const refreshRefused = () =>
	Response.json({ error: "invalid_grant", error_description: "refresh token has been revoked" }, { status: 400 });

async function runtimeWith(credential: Credential): Promise<{ runtime: ModelRuntime; credentials: AuthStorage }> {
	const credentials = AuthStorage.inMemory();
	await credentials.modify("chatgpt-subscription", async () => credential);
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
const options = { transport: "sse" as const, maxRetries: 0 };
const stored = (): Credential => ({
	type: "oauth",
	access: SERVER_EXPIRED,
	refresh: "rt_still_valid",
	expires: Date.now() + 5 * 24 * HOURS,
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "issue-3407-"));
	calls = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

describe("issue #3407: a ChatGPT token the server says has expired is refreshed once", () => {
	it("refreshes on the 401 'token has expired', retries once with the new token, and stores it", async () => {
		vi.stubGlobal("fetch", vi.fn(fakeChatGpt(refreshes)));
		const { runtime, credentials } = await runtimeWith(stored());

		const events = await collect(runtime.stream(getModel("chatgpt-subscription", "gpt-5.5"), context, options));

		expect(events.at(-1)?.type).toBe("done");
		const inference = calls.filter((call) => call.url === ENDPOINT);
		expect(inference.map((call) => call.auth)).toEqual([`Bearer ${SERVER_EXPIRED}`, `Bearer ${FRESH}`]);
		const refreshCalls = calls.filter((call) => call.url === TOKEN_URL);
		expect(refreshCalls).toHaveLength(1);
		expect(refreshCalls[0]?.body).toContain("refresh_token=rt_still_valid");
		const saved = await credentials.read("chatgpt-subscription");
		expect(saved?.type === "oauth" ? [saved.access, saved.refresh] : undefined).toEqual([FRESH, "rt_rotated"]);
	});

	it("when the refresh itself is refused, the turn says to sign in to ChatGPT again", async () => {
		vi.stubGlobal("fetch", vi.fn(fakeChatGpt(refreshRefused)));
		const { runtime } = await runtimeWith(stored());

		const events = await collect(runtime.stream(getModel("chatgpt-subscription", "gpt-5.5"), context, options));

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		const message = terminal?.type === "error" ? (terminal.error.errorMessage ?? "") : "";
		expect(message).toContain("sign in to ChatGPT Subscription (Plus/Pro) again");
		expect(message).not.toContain("Your authentication token has expired");
		expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(1);
	});
});

// Lead ruling on #3842: only a 401 that names the TOKEN as expired or invalid is refreshed (once);
// any other 401 is surfaced as it is, with no refresh (no refresh-token rotation burned) and no
// re-exchange note (the note is what blocks a pooled slot until a new login).
const body401 = (message: string, code: string | null, type = "invalid_request_error") =>
	JSON.stringify({ error: { message, type, code, param: null } });

describe("issue #3407 / #3842: a 401 is a refused token only when its body says the token is bad", () => {
	it.each([
		[
			"code token_expired",
			body401("Your authentication token has expired. Please try refreshing it.", "token_expired"),
		],
		["code invalid_token", body401("The access token provided is invalid.", "invalid_token")],
		["revoked wording", body401("Your access token has been revoked. Please sign in again.", "token_revoked")],
	])("%s: refreshes once and retries with the new token", async (_name, refusal) => {
		vi.stubGlobal("fetch", vi.fn(fakeChatGpt(refreshes, refusal)));
		const { runtime } = await runtimeWith(stored());

		const events = await collect(runtime.stream(getModel("chatgpt-subscription", "gpt-5.5"), context, options));

		expect(events.at(-1)?.type).toBe("done");
		expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(1);
		expect(calls.filter((call) => call.url === ENDPOINT)).toHaveLength(2);
	});

	it.each([
		[
			"workspace membership",
			body401(
				"You do not have an account because it has been deactivated or you are not a member of this workspace.",
				"account_deactivated",
			),
		],
		[
			"plan entitlement",
			body401("Your plan does not include access to Codex. Upgrade your plan to continue.", "plan_not_entitled"),
		],
		[
			"unsupported region",
			body401("Country, region, or territory not supported.", "unsupported_country_region_territory"),
		],
		["bare unauthorized", body401("Unauthorized", null, "unauthorized")],
	])("%s: surfaces the real error with no refresh, no retry and no re-login note", async (_name, refusal) => {
		vi.stubGlobal("fetch", vi.fn(fakeChatGpt(refreshes, refusal)));
		const { runtime } = await runtimeWith(stored());

		const events = await collect(runtime.stream(getModel("chatgpt-subscription", "gpt-5.5"), context, options));

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		const message = terminal?.type === "error" ? (terminal.error.errorMessage ?? "") : "";
		expect(message).not.toContain("freshly re-exchanged token");
		expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(0);
		expect(calls.filter((call) => call.url === ENDPOINT)).toHaveLength(1);
	});
});
