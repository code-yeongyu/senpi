import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Context, Model } from "../src/types.ts";
import {
	normalizeToolParametersForMoonshot,
	normalizeToolParametersForOpenAICompat,
} from "../src/utils/tool-schema-compat.ts";

describe("tool-schema-compat", () => {
	describe("normalizeToolParametersForOpenAICompat", () => {
		it("removes a sibling type keyword from anyOf nodes", () => {
			const schema = {
				type: "object",
				properties: {
					mode: {
						type: "string",
						anyOf: [
							{ type: "string", const: "fast" },
							{ type: "string", const: "slow" },
						],
					},
				},
			};

			const normalized = normalizeToolParametersForOpenAICompat(schema);

			expect(normalized).toEqual({
				type: "object",
				properties: {
					mode: {
						type: "string",
						enum: ["fast", "slow"],
					},
				},
			});
		});

		it("moves a parent type into untyped combiner branches", () => {
			const schema = {
				type: "object",
				anyOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "number" } } }],
			};

			const normalized = normalizeToolParametersForOpenAICompat(schema);

			expect(normalized).toEqual({
				anyOf: [
					{ type: "object", properties: { a: { type: "string" } } },
					{ type: "object", properties: { b: { type: "number" } } },
				],
			});
		});

		it("collapses a homogeneous const union into a typed enum", () => {
			const schema = {
				anyOf: [
					{ type: "string", const: "alpha" },
					{ type: "string", const: "beta" },
				],
			};

			const normalized = normalizeToolParametersForOpenAICompat(schema);

			expect(normalized).toEqual({ type: "string", enum: ["alpha", "beta"] });
		});

		it("recurses through nested properties and items", () => {
			const schema = {
				type: "object",
				properties: {
					tags: {
						type: "array",
						items: {
							type: "string",
							anyOf: [
								{ type: "string", const: "x" },
								{ type: "string", const: "y" },
							],
						},
					},
				},
			};

			const normalized = normalizeToolParametersForOpenAICompat(schema);

			expect(normalized).toEqual({
				type: "object",
				properties: {
					tags: {
						type: "array",
						items: { type: "string", enum: ["x", "y"] },
					},
				},
			});
		});
	});

	describe("normalizeToolParametersForMoonshot", () => {
		it("flattens a root union of object parameter shapes", () => {
			const schema = {
				anyOf: [
					{
						type: "object",
						required: ["app", "element_index"],
						properties: {
							app: { type: "string" },
							element_index: { type: "integer" },
						},
						additionalProperties: false,
					},
					{
						type: "object",
						required: ["app", "x", "y"],
						properties: {
							app: { type: "string" },
							x: { type: "number" },
							y: { type: "number" },
						},
						additionalProperties: false,
					},
				],
			};

			const normalized = normalizeToolParametersForMoonshot(schema);

			expect(normalized).toEqual({
				type: "object",
				required: ["app"],
				properties: {
					app: { type: "string" },
					element_index: { type: "integer" },
					x: { type: "number" },
					y: { type: "number" },
				},
			});
		});

		it("strips format and examples annotations", () => {
			const schema = {
				type: "object",
				properties: {
					when: {
						type: "string",
						format: "date-time",
						examples: ["2025-01-01T00:00:00Z"],
						anyOf: [{ type: "string", const: "now" }],
					},
				},
			};

			const normalized = normalizeToolParametersForMoonshot(schema);

			expect(normalized).toEqual({
				type: "object",
				properties: {
					when: {
						anyOf: [{ type: "string", const: "now" }],
					},
				},
			});
		});

		it("normalizes tools injected by the final payload hook", async () => {
			const requestBodies: Array<Record<string, unknown>> = [];
			const server = http.createServer(async (req, res) => {
				let body = "";
				for await (const chunk of req) {
					body += chunk.toString();
				}
				requestBodies.push(JSON.parse(body) as Record<string, unknown>);

				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-schema",
						object: "chat.completion.chunk",
						created: 0,
						model: "kimi-test",
						choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
					})}\n\n`,
				);
				res.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-schema",
						object: "chat.completion.chunk",
						created: 0,
						model: "kimi-test",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					})}\n\n`,
				);
				res.write("data: [DONE]\n\n");
				res.end();
			});
			server.listen(0, "127.0.0.1");
			await once(server, "listening");

			try {
				const { port } = server.address() as AddressInfo;
				const model: Model<"openai-completions"> = {
					id: "kimi-test",
					name: "Kimi Test",
					api: "openai-completions",
					provider: "moonshotai",
					baseUrl: `http://127.0.0.1:${port}`,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 4096,
				};
				const context: Context = {
					messages: [{ role: "user", content: "hello", timestamp: 1 }],
				};

				const result = await streamOpenAICompletions(model, context, {
					apiKey: "test-key",
					onPayload: (payload) => {
						if (typeof payload !== "object" || payload === null) {
							throw new Error("Expected an object payload");
						}
						return {
							...payload,
							tools: [
								{
									type: "function",
									function: {
										name: "injected_tool",
										description: "Injected after the initial conversion",
										parameters: {
											type: "object",
											anyOf: [
												{ properties: { path: { type: "string" } } },
												{ properties: { query: { type: "string" } } },
											],
										},
									},
								},
							],
						};
					},
				}).result();

				expect(result.stopReason).toBe("stop");
				const tools = requestBodies[0]?.tools;
				expect(tools).toEqual([
					{
						type: "function",
						function: {
							name: "injected_tool",
							description: "Injected after the initial conversion",
							parameters: {
								type: "object",
								properties: {
									path: { type: "string" },
									query: { type: "string" },
								},
							},
						},
					},
				]);
			} finally {
				server.close();
				await once(server, "close");
			}
		});
	});
});

async function captureChatCompletionsBodies(): Promise<{
	bodies: Array<Record<string, unknown>>;
	port: number;
	close: () => Promise<void>;
}> {
	const bodies: Array<Record<string, unknown>> = [];
	const server = http.createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) {
			body += chunk.toString();
		}
		bodies.push(JSON.parse(body) as Record<string, unknown>);

		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-schema",
				object: "chat.completion.chunk",
				created: 0,
				model: "schema-test",
				choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
			})}\n\n`,
		);
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-schema",
				object: "chat.completion.chunk",
				created: 0,
				model: "schema-test",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\n`,
		);
		res.write("data: [DONE]\n\n");
		res.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return {
		bodies,
		port,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
}

function openAICompatModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "schema-test",
		name: "Schema Test",
		api: "openai-completions",
		provider: "openai",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

const scanLikeParameters = {
	type: "object",
	properties: {
		ruleFile: { type: "string" },
		inlineRules: { type: "string" },
		paths: { type: "array", items: { type: "string" } },
	},
	required: ["paths"],
	oneOf: [
		{ required: ["ruleFile"], not: { required: ["inlineRules"] } },
		{ required: ["inlineRules"], not: { required: ["ruleFile"] } },
	],
	additionalProperties: false,
} as const;

describe("OpenAI-completions wire boundary", () => {
	it("keeps a root object type on combiner tool schemas", async () => {
		const { bodies, port, close } = await captureChatCompletionsBodies();
		try {
			const model = openAICompatModel(`http://127.0.0.1:${port}`);
			const context: Context = {
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
				tools: [
					{
						name: "mcp__ast_grep_scan",
						description: "Scan files with YAML rules.",
						parameters: Type.Unsafe(scanLikeParameters),
					},
				],
			};

			const result = await streamOpenAICompletions(model, context, { apiKey: "test-key" }).result();

			expect(result.stopReason).toBe("stop");
			const tools = bodies[0]?.tools as Array<{
				type: string;
				function: { parameters: Record<string, unknown> };
			}>;
			const parameters = tools[0]?.function.parameters;
			expect(parameters?.type).toBe("object");
			expect(parameters?.oneOf).toHaveLength(2);
			expect(parameters?.properties).toHaveProperty("paths");
		} finally {
			await close();
		}
	});

	it("keeps a root object type on tools injected after the initial conversion", async () => {
		const { bodies, port, close } = await captureChatCompletionsBodies();
		try {
			const model = openAICompatModel(`http://127.0.0.1:${port}`);
			const context: Context = {
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			};

			const result = await streamOpenAICompletions(model, context, {
				apiKey: "test-key",
				onPayload: (payload) => {
					if (typeof payload !== "object" || payload === null) {
						throw new Error("Expected an object payload");
					}
					return {
						...payload,
						tools: [
							{
								type: "function",
								function: {
									name: "mcp__ast_grep_scan",
									description: "Scan files with YAML rules.",
									parameters: scanLikeParameters,
								},
							},
						],
					};
				},
			}).result();

			expect(result.stopReason).toBe("stop");
			const tools = bodies[0]?.tools as Array<{
				type: string;
				function: { parameters: Record<string, unknown> };
			}>;
			const parameters = tools[0]?.function.parameters;
			expect(parameters?.type).toBe("object");
			expect(parameters?.oneOf).toHaveLength(2);
		} finally {
			await close();
		}
	});
});
