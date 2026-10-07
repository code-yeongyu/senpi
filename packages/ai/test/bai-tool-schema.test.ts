import { describe, expect, it } from "vitest";
import { Type } from "../src/index.ts";
import { BAI_MODELS } from "../src/providers/bai.models.ts";
import { type BaiApi, baiProvider } from "../src/providers/bai.ts";
import type { Context, Model, Tool } from "../src/types.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

const unionRootTool: Tool = {
	name: "workpool",
	description: "Union-root function schema compatibility probe.",
	parameters: Type.Union([
		Type.Object({ op: Type.Literal("create"), name: Type.String() }),
		Type.Object({ op: Type.Literal("inspect"), pool_id: Type.String() }),
	]),
};

const objectRootTool: Tool = {
	name: "read",
	description: "Object-root control.",
	parameters: Type.Object({ path: Type.String() }),
};

const STOP = "bai-wire-capture-stop";
const catalog: readonly Model<BaiApi>[] = Object.values(BAI_MODELS);

function modelFor(id: string): Model<BaiApi> {
	const model = catalog.find((entry) => entry.id === id);
	if (!model) throw new Error(`missing B.AI catalog entry: ${id}`);
	return model;
}

async function captureRequest(id: string, tools: Tool[]): Promise<{ url: string; body: Record<string, unknown> }> {
	const model = modelFor(id);
	const context: Context = {
		systemPrompt: "probe",
		messages: [{ role: "user", content: "hi", timestamp: 1 }],
		tools,
	};
	let captured: { url: string; body: Record<string, unknown> } | undefined;
	const events: unknown[] = [];
	const stream = baiProvider({ models: [model] }).streamSimple(model, normalizeContext(context), {
		apiKey: "bai-test-key",
		maxTokens: 16,
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			captured = { url: request.url, body: JSON.parse(await request.clone().text()) };
			throw new Error(STOP);
		}) as typeof fetch,
	});
	try {
		for await (const event of stream) events.push(event);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes(STOP)) throw error;
	}
	if (!captured) throw new Error(`no request captured for ${id}`);
	return captured;
}

function toolSchema(body: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
	const tools = (body.tools ?? []) as Record<string, unknown>[];
	const entry = tools.find((candidate) => {
		const nested = candidate.function as { name?: string } | undefined;
		return candidate.name === name || nested?.name === name;
	});
	if (!entry) return undefined;
	const nested = entry.function as { parameters?: unknown } | undefined;
	return (entry.parameters ?? nested?.parameters ?? entry.input_schema) as Record<string, unknown>;
}

const WIRE_APIS = [
	["openai-responses", "gpt-5.6-sol", "https://api.b.ai/v1/responses"],
	["openai-completions", "gemini-3.8-flash", "https://api.b.ai/v1/chat/completions"],
	["anthropic-messages", "claude-sonnet-5", "https://api.b.ai/v1/messages"],
] as const;

describe("B.AI tool schema compatibility on the wire", () => {
	it.each(WIRE_APIS)("keeps union-root tool parameters reachable (%s)", async (_api, id, url) => {
		const captured = await captureRequest(id, [unionRootTool]);
		expect(captured.url.startsWith(url)).toBe(true);

		const schema = toolSchema(captured.body, "workpool");
		expect(schema?.type).toBe("object");
		expect(Object.keys((schema?.properties ?? {}) as object).sort()).toEqual(["name", "op", "pool_id"]);
		expect(schema?.required).toEqual(["op"]);
	});

	it.each(WIRE_APIS)("leaves an object-root tool schema intact (%s)", async (_api, id) => {
		const captured = await captureRequest(id, [objectRootTool]);
		const schema = toolSchema(captured.body, "read");

		expect(schema?.type).toBe("object");
		expect(Object.keys((schema?.properties ?? {}) as object)).toEqual(["path"]);
	});

	it("uses the output-token field each B.AI endpoint documents", async () => {
		const [responses, completions, messages] = await Promise.all(
			WIRE_APIS.map(([, id]) => captureRequest(id, [unionRootTool])),
		);

		expect(responses?.body.max_output_tokens).toBe(16);
		expect(responses?.body.max_tokens).toBeUndefined();
		expect(responses?.body.max_completion_tokens).toBeUndefined();
		expect(completions?.body.max_completion_tokens).toBe(16);
		expect(messages?.body.max_tokens).toBe(16);
	});
});
