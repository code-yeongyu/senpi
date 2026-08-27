import type { Tool } from "../../../types.ts";
import { createRecoveryCodeMask } from "../../recovery-code-mask.ts";
import type { ParserOptions, StreamParserEvent } from "../../types.ts";
import type { RecoveryStreamParser } from "../anthropic-xml/recovery-stream.ts";
import {
	getPartialXtmlSuffix,
	matchXtmlChannelMarker,
	parseXtmlAttributes,
	XTML_ARGUMENT_CLOSE,
	XTML_ARGUMENT_OPEN,
	XTML_CALL_CLOSE,
	XTML_CALL_OPEN,
	XTML_CLOSE_PREFIX,
	XTML_OPEN_PREFIX,
	XTML_SEP,
	XTML_TOOLS_CLOSE,
	XTML_TOOLS_OPEN,
} from "./markers.ts";
import { coerceXtmlArgumentValue } from "./parse.ts";

type ParserMode =
	| "text"
	| "tools"
	| "call-header"
	| "call-body"
	| "argument-header"
	| "argument-value"
	| "discard-call";

const MARKER_PREFIXES = [XTML_OPEN_PREFIX, XTML_CLOSE_PREFIX, XTML_SEP] as const;

function findMarkerStart(text: string): number | undefined {
	return MARKER_PREFIXES.map((prefix) => text.indexOf(prefix))
		.filter((index) => index !== -1)
		.sort((a, b) => a - b)[0];
}

function couldExtendMarker(buffer: string, marker: string): boolean {
	if (marker.endsWith(XTML_SEP)) return false;
	const rest = buffer.slice(marker.length);
	return rest.length === 0 || XTML_SEP.startsWith(rest);
}

const STRUCTURAL_MARKER_OPENS = [XTML_CALL_OPEN, XTML_ARGUMENT_OPEN] as const;

function startsCompleteStructuralMarker(buffer: string): boolean {
	return STRUCTURAL_MARKER_OPENS.some((open) => buffer.startsWith(open));
}

function startsPartialStructuralMarker(buffer: string): boolean {
	return STRUCTURAL_MARKER_OPENS.some((open) => buffer.length < open.length && open.startsWith(buffer));
}

export function createXtmlRecoveryStreamParser(tools: readonly Tool[], options?: ParserOptions): RecoveryStreamParser {
	const mask = createRecoveryCodeMask();
	let buffer = "";
	let mode: ParserMode = "text";
	let callIndex = -1;
	let callName = "";
	let callArgs: Record<string, unknown> = {};
	let callStarted = false;
	let callInvalidReason: string | null = null;
	let argumentKey = "";
	let argumentType: string | undefined;

	function resetCall(): void {
		callName = "";
		callArgs = {};
		callStarted = false;
		callInvalidReason = null;
		argumentKey = "";
		argumentType = undefined;
	}

	function endCall(events: StreamParserEvent[], incomplete: boolean): void {
		if (!callStarted) {
			resetCall();
			return;
		}
		const event: StreamParserEvent = {
			type: "toolcall_end",
			index: callIndex,
			name: callName,
			id: `recovered-xtml-${callIndex}`,
			arguments: callArgs,
		};
		if (incomplete) {
			event.incomplete = true;
			if (callInvalidReason) event.errorMessage = callInvalidReason;
		}
		events.push(event);
		resetCall();
		mode = "tools";
	}

	function processText(events: StreamParserEvent[]): boolean {
		const markerIndex = findMarkerStart(buffer);
		if (markerIndex === undefined) {
			const partial = getPartialXtmlSuffix(buffer, MARKER_PREFIXES);
			const flushable = partial ? buffer.slice(0, -partial.length) : buffer;
			if (flushable) events.push({ type: "text", text: flushable });
			buffer = partial;
			return false;
		}
		if (markerIndex > 0) {
			events.push({ type: "text", text: buffer.slice(0, markerIndex) });
			buffer = buffer.slice(markerIndex);
			return true;
		}
		if (startsCompleteStructuralMarker(buffer)) {
			mode = "tools";
			return true;
		}
		if (startsPartialStructuralMarker(buffer)) return false;
		const marker = matchXtmlChannelMarker(buffer);
		if (marker) {
			if (couldExtendMarker(buffer, marker)) return false;
			buffer = buffer.slice(marker.length);
			if (marker === XTML_TOOLS_OPEN) mode = "tools";
			return true;
		}
		events.push({ type: "text", text: buffer.slice(0, 2) });
		buffer = buffer.slice(2);
		return true;
	}

	function process(events: StreamParserEvent[]): void {
		for (;;) {
			if (mode === "text") {
				if (!processText(events)) return;
				continue;
			}
			if (mode === "tools") {
				const callStart = buffer.indexOf(XTML_CALL_OPEN);
				const toolsEnd = buffer.indexOf(XTML_TOOLS_CLOSE);
				if (toolsEnd !== -1 && (callStart === -1 || toolsEnd < callStart)) {
					buffer = buffer.slice(toolsEnd + XTML_TOOLS_CLOSE.length);
					mode = "text";
					continue;
				}
				if (callStart === -1) return;
				buffer = buffer.slice(callStart + XTML_CALL_OPEN.length);
				mode = "call-header";
				continue;
			}
			if (mode === "call-header" || mode === "argument-header") {
				const sepIndex = buffer.indexOf(XTML_SEP);
				if (sepIndex === -1) return;
				const attributes = parseXtmlAttributes(buffer.slice(0, sepIndex));
				buffer = buffer.slice(sepIndex + XTML_SEP.length);
				if (mode === "call-header") {
					const name = attributes.tool ?? "";
					if (!tools.some((candidate) => candidate.name === name)) {
						options?.onError?.(`kimi-xtml recovery: call for unknown tool "${name}".`, {});
						mode = "discard-call";
						continue;
					}
					callIndex += 1;
					callName = name;
					callStarted = true;
					events.push({ type: "toolcall_start", index: callIndex, name, id: `recovered-xtml-${callIndex}` });
					mode = "call-body";
					continue;
				}
				argumentKey = attributes.key ?? "";
				argumentType = attributes.type;
				mode = "argument-value";
				continue;
			}
			if (mode === "call-body") {
				const argStart = buffer.indexOf(XTML_ARGUMENT_OPEN);
				const callEnd = buffer.indexOf(XTML_CALL_CLOSE);
				if (callEnd !== -1 && (argStart === -1 || callEnd < argStart)) {
					buffer = buffer.slice(callEnd + XTML_CALL_CLOSE.length);
					endCall(events, callInvalidReason !== null);
					continue;
				}
				if (argStart === -1) return;
				buffer = buffer.slice(argStart + XTML_ARGUMENT_OPEN.length);
				mode = "argument-header";
				continue;
			}
			if (mode === "argument-value") {
				const valueEnd = buffer.indexOf(XTML_ARGUMENT_CLOSE);
				if (valueEnd === -1) return;
				const coerced = coerceXtmlArgumentValue(buffer.slice(0, valueEnd), argumentType);
				buffer = buffer.slice(valueEnd + XTML_ARGUMENT_CLOSE.length);
				if (!coerced.ok) {
					callInvalidReason = `kimi-xtml recovery: invalid value for argument "${argumentKey}".`;
					options?.onError?.(callInvalidReason, { toolCall: callName });
				} else if (argumentKey) {
					callArgs[argumentKey] = coerced.value;
					events.push({ type: "toolcall_delta", index: callIndex, argumentsDelta: JSON.stringify(callArgs) });
				}
				mode = "call-body";
				continue;
			}
			const callEnd = buffer.indexOf(XTML_CALL_CLOSE);
			if (callEnd === -1) return;
			buffer = buffer.slice(callEnd + XTML_CALL_CLOSE.length);
			resetCall();
			mode = "tools";
		}
	}

	function consume(segments: readonly { readonly text: string; readonly scan: boolean }[]): StreamParserEvent[] {
		const events: StreamParserEvent[] = [];
		for (const segment of segments) {
			if (segment.scan) {
				buffer += segment.text;
				process(events);
				continue;
			}
			if (mode === "text" && buffer) {
				events.push({ type: "text", text: buffer });
				buffer = "";
			}
			if (mode === "text") events.push({ type: "text", text: segment.text });
			else buffer += segment.text;
		}
		return events;
	}

	return {
		feed(textDelta: string): StreamParserEvent[] {
			return consume(mask.feed(textDelta));
		},
		interrupt(): StreamParserEvent[] {
			const events: StreamParserEvent[] = [];
			if (mode === "text" && buffer) {
				events.push({ type: "text", text: buffer });
				buffer = "";
			}
			return events;
		},
		finish(): StreamParserEvent[] {
			const events: StreamParserEvent[] = consume(mask.finish());
			if (mode === "text") {
				let rest = buffer;
				for (;;) {
					const marker = matchXtmlChannelMarker(rest);
					if (!marker) break;
					rest = rest.slice(marker.length);
				}
				if (XTML_SEP.startsWith(rest) && rest.length > 0) rest = "";
				if (rest) events.push({ type: "text", text: rest });
			} else if (callStarted) {
				endCall(events, true);
			}
			buffer = "";
			mode = "text";
			return events;
		},
	};
}
