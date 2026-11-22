import type { AssistantMessage, AssistantMessageEvent, Usage } from "../types.ts";
import type { AssistantCapture, CaptureHint, CaptureState } from "./assistant-capture.ts";
import { seedNextOffset } from "./assistant-seed-frontier.ts";

type PublicBlock = AssistantMessage["content"][number];
const NO_CHANGE = Object.freeze({});

export function freezeCapture<T>(value: T): T {
	const freeze = (part: unknown): void => {
		if (part === null || typeof part !== "object" || Object.isFrozen(part)) return;
		for (const child of Object.values(part)) freeze(child);
		Object.freeze(part);
	};
	const copy = structuredClone(value);
	freeze(copy);
	return copy;
}

/** Only declared public fields survive; provider scratch and symbols never enter a seed. */
export function publicBlock(block: PublicBlock): PublicBlock {
	const fields = {
		text: ["type", "text", "audience", "textSignature"],
		thinking: ["type", "thinking", "thinkingSignature", "redacted", "startedAt", "endedAt"],
		toolCall: ["type", "id", "name", "arguments", "incomplete", "errorMessage", "thoughtSignature", "namespace"],
		providerNative: ["type", "subtype", "raw"],
	};
	return Object.fromEntries(
		fields[block.type].filter((key) => key in block).map((key) => [key, Reflect.get(block, key)]),
	) as PublicBlock;
}

/** Structural equality over plain data; any other object counts as changed, so a reused copy is never stale. */
export function sameValue(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (!isPlainData(left) || !isPlainData(right) || Array.isArray(left) !== Array.isArray(right)) return false;
	const keys = Object.keys(left);
	return (
		keys.length === Object.keys(right).length &&
		keys.every((key) => Object.hasOwn(right, key) && sameValue(Reflect.get(left, key), Reflect.get(right, key)))
	);
}

function isPlainData(value: unknown): value is object {
	if (typeof value !== "object" || value === null) return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === Array.prototype || prototype === null;
}

/** A terminal replaced downstream: its usage and message, plus every scalar that differs from the source terminal. */
export function terminalCapture(capture: AssistantCapture, terminal: AssistantMessage): AssistantCapture {
	const metadata: Record<string, unknown> = { ...capture.metadata };
	const previous: object = capture.message ?? {};
	for (const key of new Set([...Object.keys(previous), ...Object.keys(terminal)])) {
		if (key === "content" || key === "usage") continue;
		const value: unknown = Reflect.get(terminal, key);
		if (!sameValue(value, Reflect.get(previous, key))) metadata[key] = key in terminal ? value : null;
	}
	return Object.freeze({
		usage: frozenUsage(terminal.usage),
		metadata: freezeCapture(metadata),
		message: freezeCapture({ ...terminal, content: terminal.content.map(publicBlock) }),
		...(capture.rewrittenFrom === undefined ? {} : { rewrittenFrom: capture.rewrittenFrom }),
	});
}

export function buildCapture(
	state: CaptureState,
	event: AssistantMessageEvent,
	hint: CaptureHint,
): AssistantCapture | undefined {
	const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
	const usage = usageCopy(state, message.usage);
	if (!("contentIndex" in event)) {
		return Object.freeze({
			usage,
			metadata: changedMetadata(state, message),
			message: freezeCapture({ ...message, content: message.content.map(publicBlock) }),
			...(hint.rewrittenFrom === undefined ? {} : { rewrittenFrom: hint.rewrittenFrom }),
		});
	}
	const index = hint.contentIndex ?? event.contentIndex;
	const own = index === event.contentIndex ? {} : { contentIndex: index };
	const carried = hint.carried;
	if ("delta" in event) {
		if (carried) {
			const { parsedThrough } = carried;
			return Object.freeze({
				usage,
				offset: carried.offset,
				...(parsedThrough === undefined ? {} : { parsedThrough }),
			});
		}
		const position = state.positions.get(index) ?? { offset: 0, parsedThrough: 0 };
		const offset = hint.offset ?? position.offset;
		position.offset = offset + event.delta.length;
		if (event.type === "toolcall_delta" && event.delta.length > 0) {
			position.parsedThrough = hint.parsedThrough ?? Math.max(position.parsedThrough, position.offset);
		}
		state.positions.set(index, position);
		return Object.freeze({
			usage,
			offset,
			...own,
			...(event.type === "toolcall_delta" ? { parsedThrough: position.parsedThrough } : {}),
		});
	}
	const metadata = changedMetadata(state, message);
	if (carried) {
		const { usage: _usage, metadata: _metadata, message: _message, offset: _offset, ...facts } = carried;
		return Object.freeze({ ...facts, usage, metadata });
	}
	const starts = event.type === "text_start" || event.type === "thinking_start" || event.type === "toolcall_start";
	const source: PublicBlock | undefined = event.type === "toolcall_end" ? event.toolCall : message.content[index];
	// A start announced before its block is appended has no seed to freeze yet.
	if (starts && source === undefined) return undefined;
	const block = freezeCapture(publicBlock(source));
	if (!starts) return Object.freeze({ usage, metadata, block, ...own });
	const rawArgumentPrefix = hint.rawArgumentPrefix ?? "";
	const coveredCodeUnits =
		block.type === "text"
			? block.text.length
			: block.type === "thinking"
				? block.thinking.length
				: rawArgumentPrefix.length;
	const parsedThrough = hint.parsedThrough ?? 0;
	const nextOffset = seedNextOffset(hint.offset ?? coveredCodeUnits, coveredCodeUnits);
	state.positions.set(index, { offset: nextOffset, parsedThrough });
	return Object.freeze({
		usage,
		metadata,
		block,
		coveredCodeUnits,
		nextOffset,
		...own,
		...(block.type === "toolCall" ? { rawArgumentPrefix, parsedThrough } : {}),
	});
}

function usageCopy(state: CaptureState, usage: Usage): Usage {
	if (state.usage !== undefined && sameValue(usage, state.usage)) return state.usage;
	state.usage = frozenUsage(usage);
	return state.usage;
}

function frozenUsage(usage: Usage): Usage {
	return Object.freeze({
		...usage,
		cost: Object.freeze({ ...usage.cost }),
		...(usage.contextUsage ? { contextUsage: Object.freeze({ ...usage.contextUsage }) } : {}),
	});
}

/** Scalar message fields changed since the last non-delta capture; the baseline moves only once its copy exists. */
function changedMetadata(state: CaptureState, message: AssistantMessage): AssistantCapture["metadata"] {
	const changed: Record<string, unknown> = {};
	for (const key of Object.keys(message)) {
		if (key === "content" || key === "usage") continue;
		const value: unknown = Reflect.get(message, key);
		if (!state.metadata.has(key) || state.metadata.get(key) !== value) changed[key] = value;
	}
	for (const key of state.metadata.keys()) if (!(key in message)) changed[key] = null;
	const frozen = Object.keys(changed).length === 0 ? NO_CHANGE : freezeCapture(changed);
	for (const key of Object.keys(changed)) {
		if (key in message) state.metadata.set(key, Reflect.get(message, key));
		else state.metadata.delete(key);
	}
	return frozen;
}
