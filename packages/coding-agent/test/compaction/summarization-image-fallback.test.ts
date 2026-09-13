import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Message, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createFileOps, DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import {
	runExtensionCompaction,
	type SpeculativeCompactionContext,
	type SpeculativeCompactionSnapshot,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const OPENAI_INVALID_IMAGE_ERROR =
	"Invalid 'input[5].output[3].image_url'. Expected a base64-encoded data URL with an image MIME type (e.g. 'data:image/png;base64,aGVsbG8='), but got an invalid base64-encoded value.";
const registrations: Array<{ unregister(): void }> = [];

function containsImage(messages: readonly AgentMessage[]): boolean {
	return messages.some(
		(message) =>
			"content" in message &&
			Array.isArray(message.content) &&
			message.content.some((block) => block.type === "image"),
	);
}

function contentText(message: Message | undefined): string[] {
	if (!message || !Array.isArray(message.content)) return [];
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
}

function richHistory(model: SpeculativeCompactionSnapshot["model"]): Message[] {
	return [
		{
			role: "user",
			content: [
				{ type: "text", text: "user text before image" },
				{ type: "image", mimeType: "image/png", data: TINY_PNG_BASE64 },
				{ type: "text", text: "user text after image" },
			],
			timestamp: 1,
		},
		{
			...fauxAssistantMessage(
				[
					{ type: "text", text: "assistant tool preface" },
					fauxToolCall("read", { path: "mixed.png" }, { id: "call-mixed" }),
					fauxToolCall("read", { path: "only.png" }, { id: "call-image-only" }),
				],
				{ timestamp: 2 },
			),
			api: model.api,
			provider: model.provider,
			model: model.id,
		},
		{
			role: "toolResult",
			toolCallId: "call-mixed",
			toolName: "read",
			content: [
				{ type: "text", text: "tool text before image" },
				{ type: "image", mimeType: "image/png", data: TINY_PNG_BASE64 },
				{ type: "text", text: "tool text after image" },
			],
			isError: false,
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: "call-image-only",
			toolName: "read",
			content: [{ type: "image", mimeType: "image/png", data: TINY_PNG_BASE64 }],
			isError: false,
			timestamp: 4,
		},
		{
			role: "user",
			content: [{ type: "image", mimeType: "image/png", data: TINY_PNG_BASE64 }],
			timestamp: 5,
		},
	];
}

function createHarness(options: { rich?: boolean } = {}) {
	const registration = registerFauxProvider({
		models: [{ id: "image-summary", contextWindow: 200_000, input: ["text", "image"] }],
	});
	registrations.push(registration);
	const model = registration.getModel();
	const messages =
		options.rich === false
			? ([
					{ role: "user", content: [{ type: "text", text: "text-only history" }], timestamp: 1 },
				] satisfies Message[])
			: richHistory(model);
	const sessionManager = SessionManager.inMemory();
	for (const message of messages) sessionManager.appendMessage(message);
	const preparedRequests: AgentMessage[][] = [];
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "x");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		api: registration.api,
		baseUrl: model.baseUrl,
		models: registration.models,
	});
	const context = {
		model,
		modelRegistry,
		sessionManager,
		getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 200_000 }),
		getMessageRevision: () => 1,
		prepareProviderRequest: async (requestMessages: AgentMessage[]) => {
			preparedRequests.push(structuredClone(requestMessages));
			return {
				messages: requestMessages,
				transformHeaders: async (headers: Record<string, string>) => ({ ...headers, "x-summary-hook": "kept" }),
				transformPayload: async (payload: unknown) => payload,
			};
		},
		applyCompaction: async () => ({ applied: true as const, reason: "ok" as const }),
	} satisfies SpeculativeCompactionContext;
	const snapshot = {
		generation: 1,
		expectedRevision: 1,
		model,
		contextWindow: 200_000,
		preparation: {
			firstKeptEntryId: "keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 10_000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS },
		},
		promptVariant: "default",
		origin: "blocking",
	} satisfies SpeculativeCompactionSnapshot;
	return { context, messages, preparedRequests, registration, snapshot };
}

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

describe("local compaction image-format fallback", () => {
	it("retries a rejected rich request once without images while preserving text and tool identity", async () => {
		const harness = createHarness();
		const sourceBefore = structuredClone(harness.messages);
		const persistedBefore = structuredClone(harness.context.sessionManager.getBranch());
		harness.registration.setResponses([
			(context) => {
				expect(containsImage(context.messages)).toBe(true);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: OPENAI_INVALID_IMAGE_ERROR });
			},
			(context) => {
				expect(containsImage(context.messages)).toBe(false);
				return fauxAssistantMessage("summary recovered without image transport");
			},
		]);

		await expect(runExtensionCompaction(harness.context, harness.snapshot)).resolves.toMatchObject({
			summary: "summary recovered without image transport",
		});

		const calls = harness.registration.getCallLog();
		expect(calls).toHaveLength(2);
		expect(containsImage(calls[0]?.context.messages ?? [])).toBe(true);
		expect(containsImage(calls[1]?.context.messages ?? [])).toBe(false);
		expect(harness.preparedRequests).toHaveLength(2);
		expect(containsImage(harness.preparedRequests[1] ?? [])).toBe(true);
		expect(calls[1]?.options?.headers).toMatchObject({ "x-summary-hook": "kept" });

		const retried = calls[1]?.context.messages ?? [];
		expect(retried.flatMap((message) => contentText(message))).toEqual(
			expect.arrayContaining([
				"user text before image",
				"user text after image",
				"assistant tool preface",
				"tool text before image",
				"tool text after image",
			]),
		);
		const assistant = retried.find((message) => message.role === "assistant");
		expect(assistant?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "toolCall", id: "call-mixed", name: "read" }),
				expect.objectContaining({ type: "toolCall", id: "call-image-only", name: "read" }),
			]),
		);
		for (const toolCallId of ["call-mixed", "call-image-only"]) {
			const result = retried.find((message) => message.role === "toolResult" && message.toolCallId === toolCallId);
			expect(result).toMatchObject({ role: "toolResult", toolCallId, toolName: "read", isError: false });
			expect(contentText(result)).not.toHaveLength(0);
		}
		const imageOnlyToolResult = retried.find(
			(message) => message.role === "toolResult" && message.toolCallId === "call-image-only",
		);
		expect(contentText(imageOnlyToolResult)).toHaveLength(1);
		const imageOnlyUser = retried.find((message) => message.role === "user" && message.timestamp === 5);
		expect(contentText(imageOnlyUser)).toHaveLength(1);
		expect(harness.messages).toEqual(sourceBefore);
		expect(harness.context.sessionManager.getBranch()).toEqual(persistedBefore);
	});

	it.each([
		"Unsupported image format: image/bmp",
		"Unsupported media type for base64 image: image/tiff",
		"Invalid data URL for image content",
	])("recognizes established provider image-format wording: %s", async (errorMessage) => {
		const harness = createHarness();
		harness.registration.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			fauxAssistantMessage("recovered summary"),
		]);

		await expect(runExtensionCompaction(harness.context, harness.snapshot)).resolves.toMatchObject({
			summary: "recovered summary",
		});
		expect(harness.registration.getCallLog()).toHaveLength(2);
	});

	it.each(["request blocked by provider policy", "invalid base64 in an unrelated metadata field"])(
		"does not retry an image-bearing request for an ordinary error: %s",
		async (errorMessage) => {
			const harness = createHarness();
			harness.registration.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);

			await expect(runExtensionCompaction(harness.context, harness.snapshot)).rejects.toThrow(errorMessage);
			expect(harness.registration.getCallLog()).toHaveLength(1);
		},
	);

	it("does not retry an image-format error when the request contains no images", async () => {
		const harness = createHarness({ rich: false });
		harness.registration.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: OPENAI_INVALID_IMAGE_ERROR }),
		]);

		await expect(runExtensionCompaction(harness.context, harness.snapshot)).rejects.toThrow(
			OPENAI_INVALID_IMAGE_ERROR,
		);
		expect(harness.registration.getCallLog()).toHaveLength(1);
	});

	it("propagates a failed fallback without spending another image retry", async () => {
		const harness = createHarness();
		harness.registration.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: OPENAI_INVALID_IMAGE_ERROR }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "fallback request failed" }),
		]);

		await expect(runExtensionCompaction(harness.context, harness.snapshot)).rejects.toThrow(
			"fallback request failed",
		);
		expect(harness.registration.getCallLog()).toHaveLength(2);
	});

	it("stands down when the caller aborts during the rejected rich attempt", async () => {
		const harness = createHarness();
		const controller = new AbortController();
		harness.registration.setResponses([
			() => {
				controller.abort("cancelled by caller");
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: OPENAI_INVALID_IMAGE_ERROR });
			},
		]);

		await expect(
			runExtensionCompaction(harness.context, harness.snapshot, controller.signal),
		).resolves.toBeUndefined();
		expect(harness.registration.getCallLog()).toHaveLength(1);
	});
});
