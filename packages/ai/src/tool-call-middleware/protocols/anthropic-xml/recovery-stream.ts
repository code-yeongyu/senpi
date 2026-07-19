import type { Tool } from "../../../types.ts";
import type { ParserOptions, StreamParser, StreamParserEvent } from "../../types.ts";
import type { InvokeProtocolConfig } from "./invoke-protocol.ts";
import { findFunctionCallsCloseTag, findFunctionCallsOpenTag } from "./invoke-stream-helpers.ts";
import { findInvokeOpenTag, isPotentialProtocolStart, scanInvokeBlock } from "./invoke-tag-scanner.ts";
import {
	ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH,
	createPendingFragment,
	type StreamBoundaryMatcher,
} from "./stream-boundary.ts";
import { createToolResolver } from "./tool-resolver.ts";

type IdleState = { readonly kind: "idle"; tag: string };
type WaitingState = {
	readonly kind: "function-calls";
	readonly opening: string;
	readonly consumed: boolean;
	content: string;
	tag: string;
};
type ActiveState = {
	readonly kind: "active";
	readonly tool: Tool;
	readonly index: number;
	readonly id: string;
	readonly closeMatcher: StreamBoundaryMatcher;
	readonly continuesWrapper: boolean;
	source: string;
};
type RecoveryState = IdleState | WaitingState | ActiveState | { readonly kind: "finished" };

const MAX_PARTIAL_TAG_VALIDATION_LENGTH = 128;

function emitText(events: StreamParserEvent[], text: string): void {
	if (text.length > 0) {
		events.push({ type: "text", text });
	}
}

/**
 * Incrementally recovers leaked ANTML invokes without changing the established
 * text-protocol stream parser. A known opening tag is the irreversible start
 * boundary; only a matching closing tag can make that call executable.
 */
export function createInvokeRecoveryStreamParser(
	tools: readonly Tool[],
	config: InvokeProtocolConfig,
	options?: ParserOptions,
): StreamParser {
	const resolveTool = createToolResolver(tools);
	let state: RecoveryState = { kind: "idle", tag: "" };
	let nextToolCallIndex = 0;

	function reportOverflow(retainedLength: number): void {
		options?.onError?.("ANTML recovery fragment exceeded the retained-input limit.", {
			protocol: config.protocol,
			retainedLength,
		});
	}

	function startKnownInvoke(events: StreamParserEvent[], opening: string, tool: Tool, continuesWrapper = false): void {
		const index = nextToolCallIndex;
		nextToolCallIndex += 1;
		const id = `recovered-antml-${index}`;
		events.push({ type: "toolcall_start", index, name: tool.name, id });
		state = {
			kind: "active",
			tool,
			index,
			id,
			closeMatcher: createPendingFragment("invoke", opening).matcher,
			continuesWrapper,
			source: opening,
		};
	}

	function finishActive(events: StreamParserEvent[], active: ActiveState): void {
		const block = scanInvokeBlock(active.source, findInvokeOpenTag(active.source, 0)!);
		const argumentsRecord =
			block?.end === active.source.length && block.parameters ? config.coerce(block.parameters, active.tool) : null;
		const argumentsValue = argumentsRecord ?? {};
		events.push({ type: "toolcall_delta", index: active.index, argumentsDelta: JSON.stringify(argumentsValue) });
		if (argumentsRecord !== null) {
			events.push({
				type: "toolcall_end",
				index: active.index,
				name: active.tool.name,
				id: active.id,
				arguments: argumentsValue,
			});
		} else {
			options?.onError?.("Recovered ANTML tool call arguments failed validation.", {
				protocol: config.protocol,
				toolName: active.tool.name,
			});
			events.push({
				type: "toolcall_end",
				index: active.index,
				name: active.tool.name,
				id: active.id,
				arguments: argumentsValue,
				incomplete: true,
				errorMessage: "Recovered tool call arguments failed validation",
			});
		}
		state = active.continuesWrapper
			? { kind: "function-calls", opening: "", consumed: true, content: "", tag: "" }
			: { kind: "idle", tag: "" };
	}

	function overflowActive(events: StreamParserEvent[], active: ActiveState): void {
		reportOverflow(active.source.length);
		events.push({ type: "toolcall_delta", index: active.index, argumentsDelta: "{}" });
		events.push({
			type: "toolcall_end",
			index: active.index,
			name: active.tool.name,
			id: active.id,
			arguments: {},
			incomplete: true,
			errorMessage: "Tool call stream ended before completion",
		});
		state = active.continuesWrapper
			? { kind: "function-calls", opening: "", consumed: true, content: "", tag: "" }
			: { kind: "idle", tag: "" };
	}

	function handleIdleTag(events: StreamParserEvent[], idle: IdleState): void {
		const invoke = findInvokeOpenTag(idle.tag, 0);
		if (invoke?.index === 0 && invoke.length === idle.tag.length) {
			const tool = resolveTool(invoke.toolName);
			if (tool) {
				startKnownInvoke(events, idle.tag, tool);
			} else {
				emitText(events, idle.tag);
				state = { kind: "idle", tag: "" };
			}
			return;
		}
		const wrapper = findFunctionCallsOpenTag(idle.tag, 0);
		if (wrapper?.index === 0 && wrapper.length === idle.tag.length) {
			state = { kind: "function-calls", opening: idle.tag, consumed: false, content: "", tag: "" };
			return;
		}
		emitText(events, idle.tag);
		state = { kind: "idle", tag: "" };
	}

	function feedIdleCharacter(events: StreamParserEvent[], character: string, idle: IdleState): void {
		if (idle.tag.length === 0 && character !== "<") {
			emitText(events, character);
			return;
		}
		if (character === "<" && idle.tag.length > 0) {
			emitText(events, idle.tag);
			idle.tag = "<";
			return;
		}
		idle.tag += character;
		if (character === ">") {
			handleIdleTag(events, idle);
		} else if (idle.tag.length === ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH) {
			reportOverflow(idle.tag.length);
			emitText(events, idle.tag);
			state = { kind: "idle", tag: "" };
		} else if (idle.tag.length <= MAX_PARTIAL_TAG_VALIDATION_LENGTH && !isPotentialProtocolStart(idle.tag)) {
			emitText(events, idle.tag);
			idle.tag = "";
		}
	}

	function feedWaitingCharacter(events: StreamParserEvent[], waiting: WaitingState, character: string): void {
		waiting.content += character;
		if (waiting.tag.length === 0 && character === "<") {
			waiting.tag = "<";
		} else if (waiting.tag.length > 0 && character === "<") {
			waiting.tag = "<";
		} else if (waiting.tag.length > 0) {
			waiting.tag += character;
		}
		if (character === ">" && waiting.tag.length > 0) {
			const invoke = findInvokeOpenTag(waiting.tag, 0);
			if (invoke?.index === 0 && invoke.length === waiting.tag.length) {
				const tool = resolveTool(invoke.toolName);
				if (tool) {
					if (!waiting.consumed) {
						emitText(events, waiting.content.slice(0, -waiting.tag.length));
					}
					startKnownInvoke(events, waiting.tag, tool, true);
				} else {
					emitText(events, waiting.opening + waiting.content);
					state = { kind: "idle", tag: "" };
				}
				return;
			}
			const close = findFunctionCallsCloseTag(waiting.tag, 0);
			if (close?.index === 0 && close.length === waiting.tag.length) {
				if (!waiting.consumed) {
					emitText(events, waiting.opening + waiting.content);
				}
				state = { kind: "idle", tag: "" };
				return;
			}
			waiting.tag = "";
		}
		if (waiting.opening.length + waiting.content.length === ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH) {
			reportOverflow(waiting.opening.length + waiting.content.length);
			emitText(events, waiting.opening + waiting.content);
			state = { kind: "idle", tag: "" };
		}
	}

	function feedActiveCharacter(events: StreamParserEvent[], active: ActiveState, character: string): void {
		active.source += character;
		if (active.closeMatcher.feed(character)) {
			finishActive(events, active);
		} else if (active.source.length === ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH) {
			overflowActive(events, active);
		}
	}

	return {
		feed(textDelta: string): StreamParserEvent[] {
			const events: StreamParserEvent[] = [];
			for (const character of textDelta) {
				if (state.kind === "finished") {
					break;
				}
				if (state.kind === "idle") {
					feedIdleCharacter(events, character, state);
				} else if (state.kind === "function-calls") {
					feedWaitingCharacter(events, state, character);
				} else {
					feedActiveCharacter(events, state, character);
				}
			}
			return events;
		},
		finish(): StreamParserEvent[] {
			const events: StreamParserEvent[] = [];
			if (state.kind === "idle") {
				emitText(events, state.tag);
			} else if (state.kind === "function-calls") {
				emitText(events, state.opening + state.content);
			}
			state = { kind: "finished" };
			return events;
		},
	};
}
