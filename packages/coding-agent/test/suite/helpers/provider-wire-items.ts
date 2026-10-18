/**
 * Every first-party adapter that maps tool results, with a reader that flattens its request body
 * into ordered user-side items (tool results and user text blocks). The body is captured through
 * `onPayload` before any network I/O, so the real serializer runs and nothing leaves the process.
 */

import { type Context, getModel, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import { expect } from "vitest";

export type WireItem =
	| { kind: "toolResult"; text: string; message: number }
	| { kind: "userText"; text: string; message: number }
	| { kind: "other"; message: number };

type Json = Record<string, unknown>;
const asRecords = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
const textOf = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));
const other = (message: number): WireItem => ({ kind: "other", message });

/** Anthropic Messages: tool_result and text blocks share one user message. */
function anthropicItems(payload: Json): WireItem[] {
	return asRecords(payload.messages).flatMap((message, index): WireItem[] => {
		if (message.role !== "user") return [other(index)];
		if (typeof message.content === "string") return [{ kind: "userText", text: message.content, message: index }];
		return asRecords(message.content).map((block): WireItem => {
			if (block.type === "tool_result") return { kind: "toolResult", text: textOf(block.content), message: index };
			if (block.type === "text") return { kind: "userText", text: String(block.text), message: index };
			return other(index);
		});
	});
}

/** Bedrock Converse: toolResult and text members of one user content list (cache points skipped). */
function bedrockItems(payload: Json): WireItem[] {
	return asRecords(payload.messages).flatMap((message, index): WireItem[] => {
		if (message.role !== "user") return [other(index)];
		return asRecords(message.content).flatMap((block): WireItem[] => {
			if (block.toolResult) return [{ kind: "toolResult", text: textOf(block.toolResult), message: index }];
			if (typeof block.text === "string") return [{ kind: "userText", text: block.text, message: index }];
			return [];
		});
	});
}

/** Gemini: functionResponse and text parts of one user content. */
function googleItems(payload: Json): WireItem[] {
	return asRecords(payload.contents).flatMap((content, index): WireItem[] => {
		if (content.role !== "user") return [other(index)];
		return asRecords(content.parts).map((part): WireItem => {
			if (part.functionResponse) return { kind: "toolResult", text: textOf(part.functionResponse), message: index };
			if (typeof part.text === "string") return { kind: "userText", text: part.text, message: index };
			return other(index);
		});
	});
}

/** Chat Completions and Mistral: each result is its own `tool` role message. */
function chatItems(payload: Json): WireItem[] {
	return asRecords(payload.messages).flatMap((message, index): WireItem[] => {
		if (message.role === "tool") return [{ kind: "toolResult", text: textOf(message.content), message: index }];
		if (message.role !== "user") return [other(index)];
		if (typeof message.content === "string") return [{ kind: "userText", text: message.content, message: index }];
		return asRecords(message.content).map(
			(part): WireItem =>
				part.type === "text" ? { kind: "userText", text: String(part.text), message: index } : other(index),
		);
	});
}

/** Responses: function_call_output items, then user message items with input_text parts. */
function responsesItems(payload: Json): WireItem[] {
	return asRecords(payload.input).flatMap((item, index): WireItem[] => {
		if (item.type === "function_call_output")
			return [{ kind: "toolResult", text: textOf(item.output), message: index }];
		if (item.role !== "user") return [other(index)];
		if (typeof item.content === "string") return [{ kind: "userText", text: item.content, message: index }];
		return asRecords(item.content).map(
			(part): WireItem =>
				part.type === "input_text" ? { kind: "userText", text: String(part.text), message: index } : other(index),
		);
	});
}

function withBaseUrl<M extends { baseUrl: string }>(model: M, baseUrl: string): M {
	return { ...model, baseUrl };
}

export interface WireTarget {
	name: string;
	model: () => Model<string>;
	items: (payload: Json) => WireItem[];
	/** The wire format lets user text share the message that carries the tool results. */
	sameMessage: boolean;
}

export const WIRE_TARGETS: WireTarget[] = [
	{
		name: "anthropic-messages",
		model: () => getModel("anthropic", "claude-haiku-4-5"),
		items: anthropicItems,
		sameMessage: true,
	},
	{
		name: "bedrock-converse-stream",
		model: () => getModel("amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0"),
		items: bedrockItems,
		sameMessage: true,
	},
	{
		name: "google-generative-ai",
		model: () => getModel("google", "gemini-2.5-flash"),
		items: googleItems,
		sameMessage: true,
	},
	{
		name: "google-vertex",
		model: () => getModel("google-vertex", "gemini-2.5-flash"),
		items: googleItems,
		sameMessage: true,
	},
	{
		name: "openai-completions",
		model: () => getModel("deepseek", "deepseek-v4-pro"),
		items: chatItems,
		sameMessage: false,
	},
	{
		name: "mistral-conversations",
		model: () => getModel("mistral", "mistral-large-2512"),
		items: chatItems,
		sameMessage: false,
	},
	{
		name: "openai-responses",
		model: () => getModel("openai", "gpt-5-mini"),
		items: responsesItems,
		sameMessage: false,
	},
	{
		name: "openai-codex-responses",
		model: () => getModel("chatgpt-subscription", "gpt-5.5"),
		items: responsesItems,
		sameMessage: false,
	},
	{
		name: "azure-openai-responses",
		model: () =>
			withBaseUrl(getModel("azure-openai-responses", "gpt-4.1"), "https://example.openai.azure.com/openai/v1"),
		items: responsesItems,
		sameMessage: false,
	},
];

export async function wireItemsFor(target: WireTarget, context: Context): Promise<{ items: WireItem[]; body: string }> {
	const model = target.model();
	expect(model.api).toBe(target.name);
	let captured: Json | undefined;
	const result = await streamSimple(model, context, {
		apiKey: "test-key",
		onPayload: (payload) => {
			captured = payload as Json;
			throw new Error("payload captured");
		},
	}).result();
	expect(result.errorMessage).toBe("payload captured");
	if (!captured) throw new Error(`${target.name} built no payload`);
	return { items: target.items(captured), body: JSON.stringify(captured) };
}
