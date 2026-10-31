import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { DEEPSEEK_MODELS } from "../src/providers/deepseek.models.ts";
import type { Context, Model } from "../src/types.ts";
import { normalizeToolParametersForOpenAICompat } from "../src/utils/tool-schema-compat.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// DeepSeek rejects every tool whose root parameters schema has no `type`:
// `schema must be a JSON Schema of 'type: "object"', got 'type: null'` (#3245).
describe("typeless tool-parameter roots get type object (#3245)", () => {
	it.each([
		{
			name: "root allOf",
			schema: { allOf: [{ type: "object", properties: { a: { type: "string" } } }, { required: ["a"] }] },
		},
		{
			name: "root $ref (characterization: already typed before #3250)",
			schema: { $ref: "#/$defs/args", $defs: { args: { type: "object", properties: { a: { type: "string" } } } } },
		},
	])("adds the object type and keeps the $name keyword", ({ schema }) => {
		const normalized = normalizeToolParametersForOpenAICompat(structuredClone(schema));

		expect(normalized).toEqual({ ...schema, type: "object" });
	});
});

async function captureFirstRequestBody(run: (baseUrl: string) => Promise<void>): Promise<Record<string, unknown>> {
	const bodies: Array<Record<string, unknown>> = [];
	const server = http.createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk.toString();
		bodies.push(JSON.parse(body) as Record<string, unknown>);
		const chunk = (delta: Record<string, unknown>, finish: string | null) =>
			`data: ${JSON.stringify({
				id: "chatcmpl-deepseek",
				object: "chat.completion.chunk",
				created: 0,
				model: "deepseek-test",
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(chunk({ content: "ok" }, null));
		res.write(chunk({}, "stop"));
		res.write("data: [DONE]\n\n");
		res.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const { port } = server.address() as AddressInfo;
		await run(`http://127.0.0.1:${port}`);
	} finally {
		server.close();
		await once(server, "close");
	}
	const first = bodies[0];
	if (!first) throw new Error("the provider received no request");
	return first;
}

describe("DeepSeek wire payload (real request builder)", () => {
	it("sends an unmergeable root union with a root type object", async () => {
		const mixedRoot = {
			anyOf: [{ type: "object", properties: { path: { type: "string" } } }, { type: "string" }],
		};

		const body = await captureFirstRequestBody(async (baseUrl) => {
			const catalogModel: Model<"openai-completions"> | undefined = Object.values(DEEPSEEK_MODELS).find(
				(candidate) => candidate.api === "openai-completions",
			);
			if (!catalogModel) throw new Error("the DeepSeek catalog has no Chat Completions model");
			const model: Model<"openai-completions"> = { ...catalogModel, baseUrl };
			const context: Context = {
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
				tools: [{ name: "read_target", description: "Read a path or a free-form target", parameters: mixedRoot }],
			};

			const result = await streamOpenAICompletions(model, normalizeContext(context), {
				apiKey: "test-key",
			}).result();
			expect(result.stopReason).toBe("stop");
		});

		const tools = body.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
		expect(tools).toHaveLength(1);
		expect(tools[0]?.function.parameters).toEqual({ ...mixedRoot, type: "object" });
	});
});
