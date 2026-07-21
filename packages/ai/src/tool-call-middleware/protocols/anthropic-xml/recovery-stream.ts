import type { Tool } from "../../../types.ts";
import type { ParserOptions, StreamParser, StreamParserEvent } from "../../types.ts";
import type { InvokeProtocolConfig } from "./invoke-protocol.ts";
import { findFunctionCallsOpenTag } from "./invoke-stream-helpers.ts";
import { findInvokeOpenTag, isPotentialProtocolStart, scanInvokeBlock } from "./invoke-tag-scanner.ts";
import { RecoveryWrapperState } from "./recovery-wrapper-state.ts";
import {
	ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH,
	createPendingFragment,
	type StreamBoundaryMatcher,
} from "./stream-boundary.ts";
import { createToolResolver } from "./tool-resolver.ts";

type IdleState = { readonly kind: "idle"; tag: string };
type WrapperState = { readonly kind: "wrapper"; readonly scanner: RecoveryWrapperState };
type ActiveState = {
	readonly kind: "active";
	readonly tool: Tool;
	readonly index: number;
	readonly id: string;
	readonly closeMatcher: StreamBoundaryMatcher;
	readonly wrapper: RecoveryWrapperState | undefined;
	source: string;
};
type RecoveryState = IdleState | WrapperState | ActiveState | { readonly kind: "finished" };
export interface RecoveryStreamParser extends StreamParser {
	interrupt(): StreamParserEvent[];
}
const MAX_PARTIAL_TAG_VALIDATION_LENGTH = 128;
function emitText(events: StreamParserEvent[], text: string): void {
	if (text.length > 0) {
		events.push({ type: "text", text });
	}
}
function exceedsRetainedLimit(retainedLength: number, incoming: string): boolean {
	return retainedLength + incoming.length > ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH;
}
/** Recovery-only eager ANTML parser; existing text-protocol parser semantics remain unchanged. */
export function createInvokeRecoveryStreamParser(
	tools: readonly Tool[],
	config: InvokeProtocolConfig,
	options?: ParserOptions,
): RecoveryStreamParser {
	const resolveTool = createToolResolver(tools);
	let state: RecoveryState = { kind: "idle", tag: "" };
	let nextToolCallIndex = 0;
	function reportOverflow(retainedLength: number): void {
		options?.onError?.("ANTML recovery fragment exceeded the retained-input limit.", {
			protocol: config.protocol,
			retainedLength,
		});
	}
	function startKnownInvoke(
		events: StreamParserEvent[],
		opening: string,
		tool: Tool,
		wrapper?: RecoveryWrapperState,
	): void {
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
			wrapper,
			source: opening,
		};
	}
	function restoreAfterActive(active: ActiveState): void {
		state = active.wrapper ? { kind: "wrapper", scanner: active.wrapper } : { kind: "idle", tag: "" };
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
		restoreAfterActive(active);
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
		restoreAfterActive(active);
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
			state = { kind: "wrapper", scanner: new RecoveryWrapperState(idle.tag, resolveTool) };
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
		if (exceedsRetainedLimit(idle.tag.length, character)) {
			reportOverflow(idle.tag.length);
			emitText(events, idle.tag);
			state = { kind: "idle", tag: "" };
			feedIdleCharacter(events, character, state);
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
	function feedWrapperCharacter(events: StreamParserEvent[], scanner: RecoveryWrapperState, character: string): void {
		for (const action of scanner.feed(character)) {
			if (action.type === "text" || action.type === "closed") {
				emitText(events, action.text);
				if (action.type === "closed") {
					state = { kind: "idle", tag: "" };
				}
			} else if (action.type === "known") {
				emitText(events, action.textBefore);
				startKnownInvoke(events, action.opening, action.tool, scanner);
			} else {
				reportOverflow(action.retainedLength);
				emitText(events, action.text);
				if (action.retainsWrapper && action.nextCharacter) {
					feedWrapperCharacter(events, scanner, action.nextCharacter);
				} else if (!action.retainsWrapper) {
					state = { kind: "idle", tag: "" };
					if (action.nextCharacter) {
						feedIdleCharacter(events, action.nextCharacter, state);
					}
				}
			}
		}
	}
	function feedActiveCharacter(events: StreamParserEvent[], active: ActiveState, character: string): void {
		if (exceedsRetainedLimit(active.source.length, character)) {
			overflowActive(events, active);
			if (state.kind === "wrapper") {
				feedWrapperCharacter(events, state.scanner, character);
			} else if (state.kind === "idle") {
				feedIdleCharacter(events, character, state);
			}
			return;
		}
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
				} else if (state.kind === "wrapper") {
					feedWrapperCharacter(events, state.scanner, character);
				} else {
					feedActiveCharacter(events, state, character);
				}
			}
			return events;
		},
		interrupt(): StreamParserEvent[] {
			const events: StreamParserEvent[] = [];
			if (state.kind === "idle") {
				emitText(events, state.tag);
				state = { kind: "idle", tag: "" };
			} else if (state.kind === "wrapper") {
				emitText(events, state.scanner.finish());
				state = { kind: "idle", tag: "" };
			}
			return events;
		},
		finish(): StreamParserEvent[] {
			const events: StreamParserEvent[] = [];
			if (state.kind === "idle") {
				emitText(events, state.tag);
			} else if (state.kind === "wrapper") {
				emitText(events, state.scanner.finish());
			}
			state = { kind: "finished" };
			return events;
		},
	};
}
