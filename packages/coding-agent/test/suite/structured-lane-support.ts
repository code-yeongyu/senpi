import { type AssistantMessage, pushAssistantProgress, type ToolCall } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "../../../ai/src/utils/event-stream.ts";
import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { RpcSessionEntry } from "../../src/modes/rpc/session-registry.ts";
import type { HarnessOptions } from "./harness.ts";
import { createStructuredHarness, type StructuredHarness } from "./structured-lane-sdk-harness.ts";

/** One scripted provider turn on a capture-enabled stream; a script that ends the stream itself gets no `done`. */
export type Script = (stream: AssistantMessageEventStream, partial: AssistantMessage) => Promise<void> | void;

export const CONTROL_TYPES = ["message_block_state", "message_block_metadata", "message_tool_arguments_reset"];

export type Lane = {
	type?: string;
	message?: { role?: string; content?: object[] };
	assistantMessageEvent?: { type?: string; contentIndex?: number; seed?: unknown; offset?: unknown };
	invalidatedBlocks?: number[];
};

export function firstAssistantMessage(records: readonly Lane[]): Lane[] {
	const start = records.findIndex((record) => record.type === "message_start" && record.message?.role === "assistant");
	const end = records.findIndex((record, index) => index > start && record.type === "message_end");
	return start === -1 || end === -1 ? [] : records.slice(start, end + 1);
}

export function textReply(text: string): Script {
	return (stream, partial) => {
		stream.push({ type: "start", partial });
		partial.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		const block = partial.content[0];
		if (block?.type === "text") block.text = text;
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
	};
}

/** Thinking (agent timing metadata), a native block (insert/end) and a tool call with an authoritative reset. */
export const allControls: Script = (stream, partial) => {
	stream.push({ type: "start", partial });
	partial.content.push({ type: "thinking", thinking: "" });
	stream.push({ type: "thinking_start", contentIndex: 0, partial });
	const thinking = partial.content[0];
	if (thinking?.type === "thinking") thinking.thinking = "plan";
	stream.push({ type: "thinking_delta", contentIndex: 0, delta: "plan", partial });
	stream.push({ type: "thinking_end", contentIndex: 0, content: "plan", partial });
	const native = { type: "providerNative" as const, subtype: "fixture", raw: { value: 1 } };
	partial.content.push(native);
	pushAssistantProgress(stream, { type: "message_block_state", contentIndex: 1, phase: "insert", block: native });
	pushAssistantProgress(stream, { type: "message_block_state", contentIndex: 1, phase: "end", block: native });
	const call: ToolCall = { type: "toolCall", id: "call_1", name: "probe", arguments: {} };
	partial.content.push(call);
	stream.push({ type: "toolcall_start", contentIndex: 2, partial });
	stream.push({ type: "toolcall_delta", contentIndex: 2, delta: '{"a":', partial });
	pushAssistantProgress(stream, {
		type: "message_tool_arguments_reset",
		contentIndex: 2,
		rawArgumentPrefix: '{"a":1}',
		parsedThrough: 7,
	});
	call.arguments = { a: 1 };
	stream.push({ type: "toolcall_end", contentIndex: 2, toolCall: call, partial });
	partial.stopReason = "toolUse";
};

/** Replaces the agent's provider with `scripts`, one per request; requests past the end answer "ok". */
export function scriptProvider(harness: StructuredHarness, scripts: Script[]): void {
	harness.agent.streamFunction = (model) => {
		const stream = new AssistantMessageEventStream({ captureBlocks: true });
		const partial: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [],
			timestamp: 1,
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const script = scripts.shift() ?? textReply("ok");
		void (async () => {
			await script(stream, partial);
			stream.push({ type: "done", reason: partial.stopReason === "toolUse" ? "toolUse" : "stop", message: partial });
			stream.end(partial);
		})();
		return stream;
	};
}

export interface ScriptedSession {
	readonly harness: StructuredHarness;
	readonly scope: ProviderScope;
	readonly runtime: AgentSessionRuntime;
	readonly entry: RpcSessionEntry;
	prompt(text: string): Promise<void>;
	close(): Promise<void>;
}

export async function scriptedSession(
	scripts: Script[],
	options: Pick<HarnessOptions, "extensionFactories"> = {},
): Promise<ScriptedSession> {
	const scope = new ProviderScope();
	const harness = await runWithProviderScope(scope, () => createStructuredHarness(options));
	scriptProvider(harness, scripts);
	const runtime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.session.agentDir,
			authStorage: harness.authStorage,
			modelRegistry: harness.modelRegistry,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("This fixture does not replace sessions");
		},
	);
	const entry: RpcSessionEntry = {
		scope,
		runtime,
		state: "open",
		kind: "interactive",
		context: {},
		profile: { cwd: harness.tempDir },
		cwd: harness.tempDir,
		attachments: 1,
		lastCommandAt: 0,
		lifecycleMutex: Promise.resolve(),
	};
	return {
		harness,
		scope,
		runtime,
		entry,
		prompt: (text) => runWithProviderScope(scope, () => harness.session.prompt(text)),
		close: async () => {
			runtime.releaseSessionHold();
			harness.cleanup();
			await scope.close();
		},
	};
}

/** The `message_*` records of a lane as `type` or `type:assistantEventType` / `type:phase` labels. */
export function messageLabels(records: readonly object[]): string[] {
	return records.flatMap((record) => {
		const value = record as { type?: unknown; assistantMessageEvent?: { type?: unknown }; phase?: unknown };
		if (typeof value.type !== "string" || !value.type.startsWith("message_")) return [];
		if (value.assistantMessageEvent) return [`${value.type}:${String(value.assistantMessageEvent.type)}`];
		return [value.phase === undefined ? value.type : `${value.type}:${String(value.phase)}`];
	});
}
