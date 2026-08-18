import loopGuardExtension from "../../src/core/extensions/builtin/loop-guard/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

export interface LoopGuardHarness {
	fire: (eventName: string, event: unknown) => Promise<unknown>;
	actions: string[];
	customMessages: Array<{
		customType: string;
		display: boolean;
		triggerTurn: boolean | undefined;
		deliverAs: string | undefined;
	}>;
	userMessages: Array<{ content: unknown; deliverAs: string | undefined }>;
	renderers: Map<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createLoopGuardHarness(): LoopGuardHarness {
	const handlers = new Map<string, Handler[]>();
	const actions: string[] = [];
	const customMessages: LoopGuardHarness["customMessages"] = [];
	const userMessages: Array<{ content: unknown; deliverAs: string | undefined }> = [];
	const renderers = new Map<string, unknown>();
	const pi: ExtensionAPI = Object.assign(Object.create(null), {
		on: (event: string, handler: Handler) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		sendMessage: (
			message: { customType: string; display: boolean },
			options: { triggerTurn?: boolean; deliverAs?: string } | undefined,
		) => {
			customMessages.push({
				customType: message.customType,
				display: message.display,
				triggerTurn: options?.triggerTurn,
				deliverAs: options?.deliverAs,
			});
			if (message.customType === "loop-guard:recovery") actions.push("recovery-turn");
		},
		sendUserMessage: (content: unknown, options: { deliverAs?: string } | undefined) => {
			actions.push("user-steer");
			userMessages.push({ content, deliverAs: options?.deliverAs });
		},
		registerMessageRenderer: (customType: string, renderer: unknown) => {
			renderers.set(customType, renderer);
		},
		events: {
			emit: (channel: string, data: unknown) => {
				if (channel === "wake_source_state" && isRecord(data) && typeof data.activeCount === "number") {
					actions.push(`wake-source:${data.activeCount}`);
				}
				if (channel === "continuation_hold_state" && isRecord(data) && typeof data.active === "boolean") {
					actions.push(`continuation-hold:${data.active ? 1 : 0}`);
				}
			},
		},
	});
	loopGuardExtension(pi);
	const ui: ExtensionContext["ui"] = Object.assign(Object.create(null), {
		notify: () => {
			actions.push("warning");
		},
	});
	const ctx: ExtensionContext = Object.assign(Object.create(null), {
		hasUI: true,
		ui,
		abort: (source: "user" | "system" | undefined) => {
			actions.push(`abort:${source ?? "user"}`);
		},
	});
	const fire = async (eventName: string, event: unknown): Promise<unknown> => {
		let result: unknown;
		for (const handler of handlers.get(eventName) ?? []) {
			const candidate = await handler(event, ctx);
			if (candidate !== undefined) result = candidate;
		}
		return result;
	};
	return { fire, actions, customMessages, userMessages, renderers };
}

export async function attempt(
	harness: LoopGuardHarness,
	toolCallId: string,
	toolName: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	await harness.fire("tool_execution_start", {
		type: "tool_execution_start",
		toolCallId,
		toolName,
		args: input,
	});
	const result = await harness.fire("tool_call", {
		type: "tool_call",
		toolCallId,
		toolName,
		input,
	});
	await harness.fire("turn_end", {
		type: "turn_end",
		message: { role: "assistant", content: [] },
		toolResults: [],
	});
	return result;
}
