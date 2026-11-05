/**
 * The scripted side of the presence rig. Each prompt carries a plan `plan:<label>:<tool>,<tool>`: the faux model calls
 * the tools in order, then answers `done`, and every provider request is logged as `{ label, step }` (step = the tool
 * results its context already held). `barrier` holds its call until `releaseBarrier()`; every other tool records where
 * it ran. `handHost(name)` is a fake hand: an explicit ToolHost, as a split session's remote host is.
 */
import type { AgentToolResult, ToolHost } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { EVENT_SAFETY_MS } from "../suite/event-safety-bound.ts";

const PLAN = /plan:(\w+):([\w,]*)/;

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
			: "";

export const toolResult = (text: string): AgentToolResult<Record<string, never>> => ({
	content: [{ type: "text", text }],
	details: {},
});

export const bounded = <T>(promise: Promise<T>, what: string): Promise<T> =>
	Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`deadline waiting for ${what}`)), EVENT_SAFETY_MS).unref();
		}),
	]);

export function createToolScript() {
	const requests: { readonly label: string; readonly step: number }[] = [];
	const handRuns: string[] = [];
	const barrierStarted = Promise.withResolvers<void>();
	const barrierRelease = Promise.withResolvers<void>();
	const runTool = async (name: string, where: string): Promise<string> => {
		if (name === "barrier") {
			barrierStarted.resolve();
			await barrierRelease.promise;
		} else handRuns.push(where);
		return name;
	};
	const script: FauxResponseFactory = (context) => {
		const texts = context.messages.filter((message) => message.role === "user").map(({ content }) => textOf(content));
		const [, label = "", tools = ""] = PLAN.exec(texts.find((text) => PLAN.test(text)) ?? "") ?? [];
		const step = context.messages.filter((message) => message.role === "toolResult").length;
		requests.push({ label, step });
		const next = tools.split(",").filter((tool) => tool !== "")[step];
		return next === undefined
			? fauxAssistantMessage("done")
			: fauxAssistantMessage([fauxToolCall(next, {})], { stopReason: "toolUse" });
	};
	const handHost = (hand: string): ToolHost => ({
		execute: async (call, { emit }) => {
			const messages: ToolResultMessage[] = [];
			for (const raw of call.calls) {
				await emit({ type: "tool_execution_start", toolCallId: raw.id, toolName: raw.name, args: raw.arguments });
				const result = { ...toolResult(await runTool(raw.name, hand)), isError: false };
				await emit({ type: "tool_execution_end", toolCallId: raw.id, toolName: raw.name, result, isError: false });
				const message: ToolResultMessage = {
					role: "toolResult",
					toolCallId: raw.id,
					toolName: raw.name,
					content: result.content,
					details: {},
					isError: false,
					timestamp: Date.now(),
				};
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				messages.push(message);
			}
			return { messages, terminate: false };
		},
	});
	return {
		script,
		runTool,
		handHost,
		handRuns,
		requests: (label: string) => requests.filter((entry) => entry.label === label).map(({ step }) => step),
		get barrierStarted() {
			return bounded(barrierStarted.promise, "the barrier");
		},
		releaseBarrier: () => barrierRelease.resolve(),
		prompt: (label: string, tools: readonly string[]) => `plan:${label}:${tools.join(",")}`,
	};
}
