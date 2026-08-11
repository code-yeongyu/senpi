import type { Tool } from "../../../types.ts";
import type { ParserOptions, StreamParserEvent } from "../../types.ts";
import { createInvokeRecoveryStreamParser, type RecoveryStreamParser } from "../anthropic-xml/recovery-stream.ts";
import { antmlInvokeConfig } from "./config.ts";

const MISSING_ANGLE_INVOKE_PREFIX = "antml:invoke";
const STRAY_FUNCTION_RESULTS_CLOSE = "</function_results>";
const MAX_MISSING_ANGLE_OPENING_LENGTH = 128;

type PendingState = { readonly kind: "none" } | { kind: "opening"; value: string } | { kind: "trailer"; value: string };

function isOpeningBoundary(character: string): boolean {
	return character.length === 0 || (!["<", "/"].includes(character) && !/[A-Za-z0-9_]/u.test(character));
}

export function createAntmlInvokeRecoveryStreamParser(
	tools: readonly Tool[],
	options?: ParserOptions,
): RecoveryStreamParser {
	const inner = createInvokeRecoveryStreamParser(tools, antmlInvokeConfig, options);
	let pending: PendingState = { kind: "none" };
	let previousCharacter = "";
	let activeMissingAngleInvoke = false;
	let syntheticAnglePending = false;

	function collectEvents(events: StreamParserEvent[], innerEvents: StreamParserEvent[]): void {
		for (const event of innerEvents) {
			if (
				syntheticAnglePending &&
				event.type === "text" &&
				event.text.startsWith(`<${MISSING_ANGLE_INVOKE_PREFIX}`)
			) {
				syntheticAnglePending = false;
				const text = event.text.slice(1);
				if (text.length > 0) {
					events.push({ type: "text", text });
				}
				continue;
			}
			if (syntheticAnglePending && event.type === "toolcall_start") {
				syntheticAnglePending = false;
				activeMissingAngleInvoke = true;
			}
			if (activeMissingAngleInvoke && event.type === "toolcall_end") {
				activeMissingAngleInvoke = false;
				if (!event.incomplete) {
					pending = { kind: "trailer", value: "" };
				}
			}
			events.push(event);
		}
	}

	function collectInner(events: StreamParserEvent[], input: string, syntheticAngle = false): void {
		syntheticAnglePending = syntheticAnglePending || syntheticAngle;
		collectEvents(events, inner.feed(input));
	}

	function flushPending(events: StreamParserEvent[]): void {
		if (pending.kind === "none") {
			return;
		}
		const value = pending.value;
		pending = { kind: "none" };
		collectInner(events, value);
	}

	function feedCharacter(events: StreamParserEvent[], character: string, openingBoundary: boolean): void {
		if (pending.kind === "trailer") {
			pending.value += character;
			const candidate = pending.value.trimStart();
			if (candidate.length === 0 || STRAY_FUNCTION_RESULTS_CLOSE.startsWith(candidate)) {
				if (candidate === STRAY_FUNCTION_RESULTS_CLOSE) {
					pending = { kind: "none" };
				} else if (pending.value.length >= MAX_MISSING_ANGLE_OPENING_LENGTH) {
					flushPending(events);
				}
				return;
			}
			const leadingWhitespace = pending.value.slice(0, pending.value.length - candidate.length);
			pending = { kind: "none" };
			collectInner(events, leadingWhitespace);
			if (character === "a" && openingBoundary) {
				pending = { kind: "opening", value: character };
			} else {
				collectInner(events, candidate);
			}
			return;
		}

		if (pending.kind === "opening") {
			pending.value += character;
			if (
				pending.value.length <= MISSING_ANGLE_INVOKE_PREFIX.length &&
				!MISSING_ANGLE_INVOKE_PREFIX.startsWith(pending.value)
			) {
				flushPending(events);
				return;
			}
			if (pending.value.length > MISSING_ANGLE_INVOKE_PREFIX.length && character === ">") {
				const opening = pending.value;
				pending = { kind: "none" };
				collectInner(events, `<${opening}`, true);
				return;
			}
			if (pending.value.length >= MAX_MISSING_ANGLE_OPENING_LENGTH) {
				flushPending(events);
			}
			return;
		}

		if (character === "a" && openingBoundary) {
			pending = { kind: "opening", value: character };
			return;
		}
		collectInner(events, character);
	}

	return {
		feed(textDelta: string): StreamParserEvent[] {
			const events: StreamParserEvent[] = [];
			for (const character of textDelta) {
				const openingBoundary = isOpeningBoundary(previousCharacter);
				previousCharacter = character;
				feedCharacter(events, character, openingBoundary);
			}
			return events;
		},
		interrupt(): StreamParserEvent[] {
			const events: StreamParserEvent[] = [];
			flushPending(events);
			collectEvents(events, inner.interrupt());
			previousCharacter = "";
			return events;
		},
		finish(): StreamParserEvent[] {
			const events: StreamParserEvent[] = [];
			flushPending(events);
			collectEvents(events, inner.finish());
			return events;
		},
	};
}
