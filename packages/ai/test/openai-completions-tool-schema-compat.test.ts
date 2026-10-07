import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Context, Model } from "../src/types.ts";
import {
	normalizeToolParametersForMoonshot,
	normalizeToolParametersForOpenAICompat,
} from "../src/utils/tool-schema-compat.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

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

		it("merges a root object union instead of hoisting the root type into branches", () => {
			// A root union used to be rewritten to a branches-only schema with no root
			// `type`, which OpenAI-compatible gateways reject outright. The root of a
			// tool's parameters must stay an object schema, so the branches are merged
			// into it instead.
			const schema = {
				type: "object",
				anyOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "number" } } }],
			};

			const normalized = normalizeToolParametersForOpenAICompat(schema);

			expect(normalized).toEqual({
				type: "object",
				properties: { a: { type: "string" }, b: { type: "number" } },
			});
		});

		it("still moves a parent type into untyped combiner branches below the root", () => {
			const schema = {
				type: "object",
				properties: {
					variant: {
						type: "object",
						anyOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "number" } } }],
					},
				},
			};

			const normalized = normalizeToolParametersForOpenAICompat(schema);

			expect(normalized).toEqual({
				type: "object",
				properties: {
					variant: {
						anyOf: [
							{ type: "object", properties: { a: { type: "string" } } },
							{ type: "object", properties: { b: { type: "number" } } },
						],
					},
				},
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

				const result = await streamOpenAICompletions(model, normalizeContext(context), {
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
	describe("root combiner schemas (regression: gateway rejects missing root type)", () => {
		// Apitopia -> Kimi replied `500 server_error: Invalid request:
		// tools.function.parameters.type is required and must be "object"` because
		// the root `type: "object"` was deleted whenever the root carried a combiner.
		// A tool's root parameters schema must always stay a valid object schema.
		const monitorShape = {
			type: "object",
			properties: {
				action: { type: "string" },
				command: { type: "string" },
				bash_id: { type: "string" },
			},
			anyOf: [{ required: ["command"] }, { required: ["bash_id"] }],
		};

		it("keeps the root type on an OpenAI-compatible root combiner schema", () => {
			const normalized = normalizeToolParametersForOpenAICompat(structuredClone(monitorShape));

			expect(normalized.type).toBe("object");
		});

		it("keeps the root type on a Moonshot-flavored root combiner schema", () => {
			const normalized = normalizeToolParametersForMoonshot(structuredClone(monitorShape));

			expect(normalized.type).toBe("object");
		});

		it("preserves root-level properties when merging a root object union", () => {
			const normalized = normalizeToolParametersForMoonshot(structuredClone(monitorShape));

			expect(Object.keys(normalized.properties as Record<string, unknown>).sort()).toEqual([
				"action",
				"bash_id",
				"command",
			]);
		});

		it("keeps root-level required entries that every branch shares", () => {
			const schema = {
				type: "object",
				required: ["to"],
				properties: {
					to: { type: "string" },
					message: { type: "string" },
					payload: { type: "object" },
				},
				oneOf: [{ required: ["message"] }, { required: ["payload"] }],
			};

			const normalized = normalizeToolParametersForMoonshot(structuredClone(schema));

			expect(normalized.type).toBe("object");
			expect(normalized.required).toEqual(["to"]);
			expect(Object.keys(normalized.properties as Record<string, unknown>).sort()).toEqual([
				"message",
				"payload",
				"to",
			]);
		});

		it("does not claim object type for a root union of non-object branches", () => {
			// Forcing `type: "object"` here would contradict every branch. The root
			// object guarantee only applies to schemas that really are objects.
			const schema = { anyOf: [{ type: "string" }, { type: "number" }] };

			const normalized = normalizeToolParametersForOpenAICompat(structuredClone(schema));

			expect(normalized.type).toBeUndefined();
			expect(normalized.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
		});

		it("does not merge a root union whose branches are not all object shapes", () => {
			const schema = {
				type: "object",
				properties: { a: { type: "string" } },
				anyOf: [{ type: "object", properties: { x: { type: "string" } } }, { type: "string" }],
			};

			const normalized = normalizeToolParametersForMoonshot(structuredClone(schema));

			expect(normalized.type).toBe("object");
			expect(normalized.properties).toEqual({ a: { type: "string" } });
		});

		it("adds the object type back to a rootless-type schema with no combiner", () => {
			const normalized = normalizeToolParametersForOpenAICompat({ properties: { a: { type: "string" } } });

			expect(normalized.type).toBe("object");
		});

		it("merges branch properties into the root object union without dropping root properties", () => {
			const schema = {
				type: "object",
				properties: { app: { type: "string" } },
				anyOf: [
					{
						type: "object",
						required: ["app", "element_index"],
						properties: { element_index: { type: "integer" } },
					},
					{ type: "object", required: ["app", "x"], properties: { x: { type: "number" } } },
				],
			};

			const normalized = normalizeToolParametersForMoonshot(structuredClone(schema));

			expect(normalized.type).toBe("object");
			expect(Object.keys(normalized.properties as Record<string, unknown>).sort()).toEqual([
				"app",
				"element_index",
				"x",
			]);
			expect(normalized.required).toEqual(["app"]);
		});
	});
	describe("wire payload (real request builder)", () => {
		it("never sends a tool whose root parameters lack type object", async () => {
			const requestBodies: Array<Record<string, unknown>> = [];
			const server = http.createServer(async (req, res) => {
				let body = "";
				for await (const chunk of req) body += chunk.toString();
				requestBodies.push(JSON.parse(body) as Record<string, unknown>);
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-root",
						object: "chat.completion.chunk",
						created: 0,
						model: "kimi-test",
						choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
					})}\n\n`,
				);
				res.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-root",
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
					tools: [
						{
							name: "monitor",
							description: "Subscribe to a command's output",
							parameters: {
								type: "object",
								properties: {
									action: { type: "string" },
									command: { type: "string" },
									bash_id: { type: "string" },
								},
								anyOf: [{ required: ["command"] }, { required: ["bash_id"] }],
							},
						},
					],
				};

				const result = await streamOpenAICompletions(model, normalizeContext(context), {
					apiKey: "test-key",
				}).result();

				expect(result.stopReason).toBe("stop");
				const tools = requestBodies[0]?.tools as Array<{
					function: { parameters: Record<string, unknown> };
				}>;
				expect(tools).toHaveLength(1);
				for (const tool of tools) {
					expect(tool.function.parameters.type).toBe("object");
					expect(Object.keys(tool.function.parameters.properties as Record<string, unknown>).sort()).toEqual([
						"action",
						"bash_id",
						"command",
					]);
				}
			} finally {
				server.close();
				await once(server, "close");
			}
		});
	});
});
