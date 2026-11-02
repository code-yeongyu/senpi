import { type Api, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import anthropicWebSearchExtension from "../../src/core/extensions/builtin/anthropic-web-search/index.ts";
import openaiWebSearchExtension from "../../src/core/extensions/builtin/openai-web-search/index.ts";
import { createToolSearchExtension, ToolSearchService } from "../../src/core/extensions/builtin/tool-search/index.ts";
import websearchExtension from "../../src/core/extensions/builtin/websearch/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness } from "./harness.ts";

describe("Moonshot server-search isolation", () => {
	it("cannot be surfaced or activated by tool_search on Anthropic and never reaches that request", async () => {
		let api: ExtensionAPI | undefined;
		const service = new ToolSearchService({
			getAllTools: () => api?.getAllTools() ?? [],
			getActiveTools: () => api?.getActiveTools() ?? [],
			setActiveTools: (names) => api?.setActiveTools([...names]),
		});
		const h = await createHarness({
			api: "anthropic-messages",
			extensionFactories: [
				{ factory: createToolSearchExtension(service), path: "<builtin:tool-search>" },
				(pi) => {
					api = pi;
					websearchExtension(pi);
				},
			],
		});
		try {
			h.agent.state.model = { ...h.agent.state.model, compat: { supportsWebSearch: true } } as Model<Api>;
			await h.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
			expect(service.getCatalog().map((doc) => doc.name)).not.toContain("$web_search");
			expect(service.activateTool("$web_search")).toBe(false);
			if (!api) throw new Error("Extension API missing");
			await expect(api.executeTool("$web_search", {}, { activateInactiveTool: true })).rejects.toMatchObject({
				code: "inactive_tool",
			});
			const payload = await h.getExtensionRunner().emitBeforeProviderRequest({
				tools: [
					{ name: "$web_search", input_schema: {} },
					{ name: "read", input_schema: {} },
				],
			});
			expect(JSON.stringify(payload)).not.toContain("$web_search");
			expect(h.session.getActiveToolNames()).not.toContain("$web_search");
		} finally {
			h.cleanup();
		}
	});
});

describe("session-model search failure memory", () => {
	it.each(["native-first", "native-last"] as const)(
		"preserves normalized function schemas across prompts and model switches with %s hook order",
		async (order) => {
			const h = await createHarness({
				api: "anthropic-messages",
				extensionFactories:
					order === "native-first"
						? [anthropicWebSearchExtension, websearchExtension]
						: [websearchExtension, anthropicWebSearchExtension],
			});
			try {
				const selected = { ...h.agent.state.model, compat: { supportsWebSearch: true } } as Model<Api>;
				h.agent.state.model = selected;
				const runner = h.getExtensionRunner();
				await runner.emit({ type: "session_start", reason: "startup" });
				const declaration = {
					name: "web_search",
					input_schema: {
						type: "object",
						properties: { query: { type: "string" } },
						required: ["query"],
						additionalProperties: false,
					},
				};
				const payload = { tools: [declaration] };
				expect(JSON.stringify(await runner.emitBeforeProviderRequest(payload))).toContain("web_search_20250305");
				await runner.emitMessageEnd({
					type: "message_end",
					message: {
						...fauxAssistantMessage("", {
							stopReason: "error",
							errorMessage: "400 web_search_20250305 rejected",
						}),
						api: selected.api,
						provider: selected.provider,
						model: selected.id,
					},
				});
				expect(JSON.parse(JSON.stringify(await runner.emitBeforeProviderRequest(payload)))).toEqual(payload);
				await runner.emitBeforeAgentStart("Next prompt", undefined, "", { cwd: h.tempDir });
				expect(JSON.parse(JSON.stringify(await runner.emitBeforeProviderRequest(payload)))).toEqual(payload);
				for (const model of [{ ...selected, id: `${selected.id}-other` }, selected]) {
					const previousModel = h.agent.state.model;
					h.agent.state.model = model;
					await runner.emitModelSelect({
						type: "model_select",
						model,
						previousModel,
						source: "set",
						systemPrompt: "",
						systemPromptOptions: { cwd: h.tempDir },
					});
					const transformed = await runner.emitBeforeProviderRequest(payload);
					if (model === selected) expect(JSON.parse(JSON.stringify(transformed))).toEqual(payload);
					else expect(JSON.stringify(transformed)).toContain("web_search_20250305");
				}
				await runner.emit({ type: "session_start", reason: "new" });
				expect(JSON.stringify(await runner.emitBeforeProviderRequest(payload))).toContain("web_search_20250305");
			} finally {
				h.cleanup();
			}
		},
	);

	it("remembers a Gemini mixed-tool rejection across later prompts without adding a second declaration entry", async () => {
		const h = await createHarness({ api: "google-generative-ai", extensionFactories: [websearchExtension] });
		try {
			h.agent.state.model = {
				...h.agent.state.model,
				id: "gemini-2.5-pro",
				compat: { supportsWebSearch: true },
			} as Model<Api>;
			const runner = h.getExtensionRunner();
			await runner.emit({ type: "session_start", reason: "startup" });
			const payload = {
				config: {
					tools: [
						{
							functionDeclarations: [
								{ name: "read", parametersJsonSchema: { type: "object" } },
								{
									name: "web_search",
									parametersJsonSchema: {
										type: "object",
										properties: { query: { type: "string" } },
										required: ["query"],
										additionalProperties: false,
									},
								},
							],
						},
					],
				},
			};
			expect(JSON.stringify(await runner.emitBeforeProviderRequest(payload))).toContain("googleSearch");
			await runner.emitMessageEnd({
				type: "message_end",
				message: {
					...fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "Tool use with function calling is unsupported",
					}),
					api: h.agent.state.model.api,
					provider: h.agent.state.model.provider,
					model: h.agent.state.model.id,
				},
			});
			await runner.emitBeforeAgentStart("Next prompt", undefined, "", { cwd: h.tempDir });
			expect(JSON.parse(JSON.stringify(await runner.emitBeforeProviderRequest(payload)))).toEqual(payload);
		} finally {
			h.cleanup();
		}
	});

	it.each(["anthropic-messages", "openai-responses"] as const)(
		"records a failure for the actual %s request model, not the selected session model",
		async (api) => {
			// senpi#3125: a model fallback can send a request different from ctx.model.
			const h = await createHarness({
				api,
				extensionFactories: [anthropicWebSearchExtension, openaiWebSearchExtension, websearchExtension],
			});
			try {
				const selected = {
					...h.agent.state.model,
					compat: { supportsWebSearch: true, supportsWebSearchPreview: true },
				};
				const failed = { ...selected, id: `${selected.id}-fallback` };
				h.agent.state.model = selected;
				const runner = h.getExtensionRunner();
				await runner.emit({ type: "session_start", reason: "startup" });
				const payload = {
					tools: [
						api === "anthropic-messages"
							? { name: "web_search", input_schema: {} }
							: { type: "function", name: "web_search", parameters: {} },
					],
				};
				const nativeType = api === "anthropic-messages" ? "web_search_20250305" : "web_search_preview";
				expect(
					JSON.stringify(
						await runner.emitBeforeProviderRequest(payload, undefined, { model: failed, headers: {} }),
					),
				).toContain(nativeType);
				await runner.emitMessageEnd({
					type: "message_end",
					message: {
						...fauxAssistantMessage("", { stopReason: "error", errorMessage: `400 ${nativeType} rejected` }),
						api,
						provider: failed.provider,
						model: failed.id,
					},
				});
				expect(
					JSON.stringify(
						await runner.emitBeforeProviderRequest(payload, undefined, { model: selected, headers: {} }),
					),
				).toContain(nativeType);
				expect(
					JSON.parse(
						JSON.stringify(
							await runner.emitBeforeProviderRequest(payload, undefined, { model: failed, headers: {} }),
						),
					),
				).toEqual(payload);
			} finally {
				h.cleanup();
			}
		},
	);
});
