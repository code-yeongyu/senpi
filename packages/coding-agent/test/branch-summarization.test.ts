import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateBranchSummary, prepareBranchEntries } from "../src/core/compaction/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const { streamSimpleMock } = vi.hoisted(() => ({
	streamSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		streamSimple: streamSimpleMock,
	};
});

function createSummaryStream(response: AssistantMessage) {
	return {
		async *[Symbol.asyncIterator]() {
			// The watchdog-driven consumer drains events; none are needed here.
		},
		result: async () => response,
	};
}

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "branch-summary-model",
		name: "Branch Summary Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function createAssistantResponse(
	text: string,
	content: AssistantMessage["content"] = [{ type: "text", text }],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createEntries(): SessionEntry[] {
	return [
		{
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "user",
				content: [{ type: "text", text: "Investigate compaction regression." }],
				timestamp: 1,
			},
		},
		{
			type: "message",
			id: "entry-2",
			parentId: "entry-1",
			timestamp: new Date().toISOString(),
			message: createAssistantResponse("I am checking branch summarization."),
		},
		{
			type: "custom_message",
			id: "entry-3",
			parentId: "entry-2",
			timestamp: new Date().toISOString(),
			customType: "test.note",
			display: true,
			content: "Remember the branch-specific observation.",
		},
	];
}

describe("branch summarization custom messages", () => {
	beforeEach(() => {
		streamSimpleMock.mockReset();
		streamSimpleMock.mockReturnValue(createSummaryStream(createAssistantResponse("## Goal\nKeep branch context")));
	});

	it("keeps custom messages in prepareBranchEntries", () => {
		// given
		const entries = createEntries();

		// when
		const result = prepareBranchEntries(entries);

		// then
		expect(result.messages).toHaveLength(3);
		expect(result.messages.some((message) => message.role === "custom")).toBe(true);
	});

	it("includes custom messages in branch summary prompts", async () => {
		// given
		const entries = createEntries();

		// when
		await generateBranchSummary(entries, {
			model: createModel(),
			apiKey: "test-key",
			signal: new AbortController().signal,
		});

		// then
		expect(streamSimpleMock).toHaveBeenCalledOnce();
		const promptText = streamSimpleMock.mock.calls[0][1].messages[0].content[0].text;
		expect(promptText).toContain("Investigate compaction regression.");
		expect(promptText).toContain("I am checking branch summarization.");
		expect(promptText).toContain("Remember the branch-specific observation.");
		expect(streamSimpleMock.mock.calls[0][2]).not.toHaveProperty("toolChoice");
		// The default (non-injected) stream path carries the same output cap as the streamFn path.
		expect(streamSimpleMock.mock.calls[0][2].maxTokens).toBe(4096);
	});

	it("rejects tool calls from branch summaries", async () => {
		streamSimpleMock.mockReturnValue(
			createSummaryStream(
				createAssistantResponse("", [
					{
						type: "toolCall",
						id: "tool-call-1",
						name: "read",
						arguments: { path: "README.md" },
					},
				]),
			),
		);

		const result = await generateBranchSummary(createEntries(), {
			model: createModel(),
			signal: new AbortController().signal,
		});

		expect(result.error).toBe("Branch summarization attempted to call a tool");
	});
});

const model: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const entries: SessionEntry[] = [
	{
		type: "message",
		id: "branch-user",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: { role: "user", content: "Abandoned request", timestamp: 1 },
	},
];

function response(content: AssistantMessage["content"]): AssistantMessage {
	return {
		...fauxAssistantMessage(""),
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

describe("branch summarization", () => {
	it("does not override tool choice for branch summaries", async () => {
		let requestOptions: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			requestOptions = options;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(requestOptions?.maxTokens).toBe(4096);
		expect(requestOptions?.toolChoice).toBeUndefined();
	});

	it("clamps the branch summary output cap to the model limit", async () => {
		let requestOptions: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			requestOptions = options;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		await generateBranchSummary(entries, {
			model: { ...model, maxTokens: 1024 },
			signal: new AbortController().signal,
			streamFn,
		});

		expect(requestOptions?.maxTokens).toBe(1024);
	});

	it("rejects tool calls from branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "toolUse",
					message: response([
						{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } },
					]),
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe("Branch summarization attempted to call a tool");
	});

	it("rejects length-limited branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "length",
					message: { ...response([{ type: "text", text: "partial" }]), stopReason: "length" },
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe(
			"Branch summarization failed: generation hit the token cap and the summary is incomplete",
		);
	});
});
