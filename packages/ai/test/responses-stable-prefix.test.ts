import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as azure } from "../src/api/azure-openai-responses.ts";
import { stream as subscription } from "../src/api/openai-codex-responses.ts";
import { stream as openai } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const routes = ["openai", "subscription", "azure"] as const;
type Route = (typeof routes)[number];
const tool: Tool = { name: "lookup", description: "Look up a record", parameters: Type.Object({ id: Type.String() }) };
const prefix: Context = {
	systemPrompt: "Stable instructions",
	tools: [tool],
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

afterEach(() => vi.restoreAllMocks());

async function capture(route: Route, context = prefix, sessionId?: string, modelId = "gpt-5.5") {
	let payload: unknown;
	vi.spyOn(globalThis, "fetch").mockImplementation(
		async () =>
			new Response(
				`data: ${JSON.stringify({
					type: "response.completed",
					response: { status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 0 } },
				})}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			),
	);
	const base = getModel("openai", "gpt-5.5");
	const model = { ...base, id: modelId };
	const options = {
		apiKey: `aaa.${Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: "synthetic" },
			}),
		).toString("base64")}.bbb`,
		sessionId,
		onPayload: (body: unknown) => {
			payload = body;
		},
	};
	const transcript = normalizeContext(context);
	switch (route) {
		case "openai":
			await openai(model, transcript, { ...options, transport: "sse" }).result();
			break;
		case "subscription":
			await subscription({ ...model, api: "openai-codex-responses", provider: "chatgpt-subscription" }, transcript, {
				...options,
				transport: "sse",
			}).result();
			break;
		case "azure":
			await azure({ ...model, api: "azure-openai-responses", provider: "azure-openai-responses" }, transcript, {
				...options,
				azureBaseUrl: "https://synthetic.openai.azure.com",
			}).result();
			break;
	}
	if (typeof payload !== "object" || payload === null || !("prompt_cache_key" in payload)) {
		throw new Error("Provider did not emit a prompt cache key");
	}
	return { key: payload.prompt_cache_key, payload };
}

// oh-my-openagent#10775: assert the provider payload, not a helper's self-comparison.
describe.each(routes)("%s stable Responses prefix", (route) => {
	it("shares a nonempty bounded key between parent and child sessions", async () => {
		const parent = await capture(route, prefix, "parent-session");
		const child = await capture(route, prefix, "child-session");
		expect(parent.key).toEqual(child.key);
		expect(parent.key).toEqual(expect.stringMatching(/^.{1,64}$/));
		expect(parent.key).not.toBe("parent-session");
	});

	it("does not need a session id or include conversation timestamps", async () => {
		const first = await capture(route, prefix, "session-one");
		const second = await capture(route, {
			...prefix,
			messages: [{ role: "user", content: "different task", timestamp: 9000 }],
		});
		expect(first.key).toEqual(second.key);
	});

	it.each(["prompt", "tools", "model"] as const)("changes its key for a different %s", async (change) => {
		const first = await capture(route, prefix, "same-session");
		const changed = {
			...prefix,
			...(change === "prompt" ? { systemPrompt: "Different instructions" } : {}),
			...(change === "tools" ? { tools: [{ ...tool, parameters: Type.Object({ query: Type.Number() }) }] } : {}),
		};
		const second = await capture(route, changed, "same-session", change === "model" ? "gpt-5.6-sol" : "gpt-5.5");
		expect(second.key).not.toEqual(first.key);
	});

	it("emits the same tool order and key for the same schema set", async () => {
		const another = { ...tool, name: "alpha" };
		const first = await capture(route, { ...prefix, tools: [tool, another] }, "one");
		const second = await capture(route, { ...prefix, tools: [another, tool] }, "two");
		expect(first.key).toEqual(second.key);
		expect(Reflect.get(first.payload, "tools")).toEqual(Reflect.get(second.payload, "tools"));
	});
});

it("uses the same derivation across API-key, subscription, and Azure routes", async () => {
	const keys = await Promise.all(routes.map(async (route) => (await capture(route, prefix, `${route}-session`)).key));
	expect(new Set(keys).size).toBe(1);
});
