import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";

import {
	createModelJobWidgetAuthor,
	forceRespondChoice,
	JOB_WIDGET_SYSTEM_PROMPT,
	JobWidgetAuthorError,
	type JobWidgetAuthorRequest,
	jobWidgetModelResolver,
	MAX_SPEC_TOKENS,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { outSample, RPS_SPEC } from "./author-support.ts";

function modelFor(api: Api, id = `${api}-model`): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider: "job-widgets-test",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 4096,
	};
}

const REQUEST: JobWidgetAuthorRequest = {
	jobId: "bg_1",
	brief: { kind: "bash", command: "./bench.sh" },
	sources: [outSample(["req 1 rps=40", "req 2 rps=44", "req 3 rps=51"])],
};

interface Call {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly options: SimpleStreamOptions;
}

function fakeComplete(response: AssistantMessage) {
	const calls: Call[] = [];
	const complete = async (model: Model<Api>, context: Context, options: SimpleStreamOptions) => {
		calls.push({ model, context, options });
		return response;
	};
	return { calls, complete };
}

const signal = new AbortController().signal;

describe("model-backed job widget author", () => {
	it("sends one request with the respond tool, no reasoning and a 3,000-token cap, and returns its arguments", async () => {
		const { calls, complete } = fakeComplete(
			fauxAssistantMessage(fauxToolCall("respond", RPS_SPEC), { stopReason: "toolUse" }),
		);
		const model = modelFor("anthropic-messages");
		const author = createModelJobWidgetAuthor({ resolveModel: () => model, complete });
		expect(await author(REQUEST, signal)).toEqual(RPS_SPEC);
		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.model).toBe(model);
		expect(call?.context.systemPrompt).toBe(JOB_WIDGET_SYSTEM_PROMPT);
		expect(call?.context.tools?.map((tool) => tool.name)).toEqual(["respond"]);
		expect(call?.options.maxTokens).toBe(MAX_SPEC_TOKENS);
		expect(call?.options.reasoning).toBeUndefined();
		expect(call?.options.signal).toBe(signal);
		const forced = await call?.options.onPayload?.({ tools: [{ name: "respond" }] }, model);
		expect(forced).toEqual({ tools: [{ name: "respond" }], tool_choice: { type: "tool", name: "respond" } });
	});

	it("parses a JSON answer given as text when the wire cannot force the tool", async () => {
		const text = `Here is the spec:\n\`\`\`json\n${JSON.stringify({ skip: "no quantity" })}\n\`\`\``;
		const { complete } = fakeComplete(fauxAssistantMessage(fauxText(text)));
		const author = createModelJobWidgetAuthor({ resolveModel: () => modelFor("mistral-conversations"), complete });
		expect(await author(REQUEST, signal)).toEqual({ skip: "no quantity" });
	});

	it("resolves undefined without a request when no model is available", async () => {
		const { calls, complete } = fakeComplete(fauxAssistantMessage("unused"));
		const author = createModelJobWidgetAuthor({ resolveModel: () => undefined, complete });
		expect(await author(REQUEST, signal)).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	it("throws a typed error for a failed or empty response", async () => {
		const failed = fakeComplete(fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" }));
		const author = createModelJobWidgetAuthor({
			resolveModel: () => modelFor("openai-responses"),
			complete: failed.complete,
		});
		await expect(author(REQUEST, signal)).rejects.toThrow(new JobWidgetAuthorError("overloaded", "error"));
		const empty = fakeComplete(fauxAssistantMessage("no spec here"));
		const second = createModelJobWidgetAuthor({
			resolveModel: () => modelFor("openai-responses"),
			complete: empty.complete,
		});
		await expect(second(REQUEST, signal)).rejects.toBeInstanceOf(JobWidgetAuthorError);
	});
});

describe("forced respond choice", () => {
	it("names the tool per wire, and leaves payloads that cannot take a forced choice alone", () => {
		const payload = { tools: [] };
		expect(forceRespondChoice(payload, modelFor("openai-responses"))).toEqual({
			tools: [],
			tool_choice: { type: "function", name: "respond" },
		});
		expect(forceRespondChoice(payload, modelFor("openai-completions"))).toEqual({
			tools: [],
			tool_choice: { type: "function", function: { name: "respond" } },
		});
		expect(forceRespondChoice(payload, modelFor("google-generative-ai"))).toBeUndefined();
		expect(forceRespondChoice({ tool_choice: "auto" }, modelFor("openai-responses"))).toBeUndefined();
		expect(forceRespondChoice({ thinking: { type: "enabled" } }, modelFor("anthropic-messages"))).toBeUndefined();
	});
});

describe("job widget model resolution", () => {
	it("prefers the setting, then the host resolver, then the session's model", () => {
		const setting = modelFor("openai-responses", "setting");
		const host = modelFor("openai-responses", "host");
		const session = modelFor("openai-responses", "session");
		expect(jobWidgetModelResolver({ setting: () => setting, host: () => host, session: () => session })()).toBe(
			setting,
		);
		expect(jobWidgetModelResolver({ setting: () => undefined, host: () => host, session: () => session })()).toBe(
			host,
		);
		expect(jobWidgetModelResolver({ host: () => undefined, session: () => session })()).toBe(session);
		expect(jobWidgetModelResolver({})()).toBeUndefined();
	});
});
