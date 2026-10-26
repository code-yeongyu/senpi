import type { AssistantMessage, AssistantMessageEvent, Usage } from "../types.ts";

type PublicBlock = AssistantMessage["content"][number];
export type AssistantProgress =
	| { type: "message_block_state"; contentIndex: number; phase: "insert" | "end"; block: PublicBlock }
	| {
			type: "message_block_metadata";
			contentIndex: number;
			thinkingSignatureDelta?: string;
			startedAt?: number;
			endedAt?: number;
	  }
	| {
			type: "message_tool_arguments_reset";
			contentIndex: number;
			rawArgumentPrefix: string;
			parsedThrough: number;
	  };
export type AssistantRecord = AssistantMessageEvent | AssistantProgress;
/** One entry of a stream's single ordered queue. */
export type OrderedEntry = { event: AssistantMessageEvent } | { progress: AssistantProgress };
type QueueReader = <V>(project: (entry: OrderedEntry) => IteratorResult<V> | undefined) => AsyncIterator<V>;
export interface AssistantCapture {
	readonly usage: Usage;
	readonly metadata?: Partial<{
		[K in keyof Omit<AssistantMessage, "content" | "usage">]: AssistantMessage[K] | null;
	}>;
	readonly block?: PublicBlock;
	readonly message?: AssistantMessage;
	readonly rawArgumentPrefix?: string;
	readonly coveredCodeUnits?: number;
	readonly offset?: number;
	readonly parsedThrough?: number;
}
interface CaptureState {
	positions: Map<number, CapturePosition>;
	metadata: Map<string, unknown>;
	usage?: Usage;
	insertCopies: Map<number, PublicBlock>;
	failedBlocks: Set<number>;
}

const captures = new WeakMap<object, AssistantCapture>();
const readers = new WeakMap<object, QueueReader>();
const writers = new WeakMap<object, (progress: AssistantProgress) => void>();
/** `undefined` until a capture-enabled stream's first push decides it, `null` once decided off. */
const states = new WeakMap<object, CaptureState | null | undefined>();
const demanded = new WeakSet<object>();
const warned = new WeakSet<object>();
const NO_CHANGE = Object.freeze({});
let subscribers = 0;
let capturedAny = false;

/** While held, every capture-enabled stream whose first push comes after it builds capture records. */
export function subscribeAssistantCapture(): () => void {
	subscribers++;
	let held = true;
	return () => {
		if (held) subscribers--;
		held = false;
	};
}

export function setAssistantReader(owner: object, reader: QueueReader): void {
	readers.set(owner, reader);
}

export function setAssistantProgressWriter(owner: object, writer: (progress: AssistantProgress) => void): void {
	writers.set(owner, writer);
}

export function enableAssistantCapture(owner: object): void {
	if (!states.has(owner)) states.set(owner, undefined);
}

/** Decided once, at the first push, so a stream never starts capturing midway with partial offsets. */
function activeState(owner: object): CaptureState | undefined {
	const state = states.get(owner);
	if (state !== undefined || !states.has(owner)) return state ?? undefined;
	const decided =
		subscribers > 0 || demanded.has(owner)
			? { positions: new Map(), metadata: new Map(), insertCopies: new Map(), failedBlocks: new Set<number>() }
			: null;
	capturedAny ||= decided !== null;
	states.set(owner, decided);
	return decided ?? undefined;
}

/** A capture failure never reaches the provider stream: the block loses its records and one warning is logged. */
function dropCapture(owner: object, error: unknown, state?: CaptureState, contentIndex?: number): void {
	if (contentIndex !== undefined) state?.failedBlocks.add(contentIndex);
	if (warned.has(owner)) return;
	warned.add(owner);
	console.warn(
		"[assistant-capture] could not build an internal capture record; that block's records are dropped",
		error,
	);
}

export function pushAssistantProgress(owner: object, progress: AssistantProgress): void {
	const writer = writers.get(owner);
	if (!writer) return;
	// A forwarded record is already a frozen public copy, made by the stream that captured it.
	if (Object.isFrozen(progress)) {
		writer(progress);
		return;
	}
	const state = activeState(owner);
	if (!state || state.failedBlocks.has(progress.contentIndex)) return;
	try {
		writer(freezeProgress(state, progress));
	} catch (error) {
		dropCapture(owner, error, state, progress.contentIndex);
	}
}

function freezeProgress(state: CaptureState, progress: AssistantProgress): AssistantProgress {
	if (progress.type === "message_tool_arguments_reset")
		state.positions.set(progress.contentIndex, {
			offset: progress.rawArgumentPrefix.length,
			parsedThrough: progress.parsedThrough,
		});
	if (progress.type !== "message_block_state") return Object.freeze({ ...progress });
	const previous = state.insertCopies.get(progress.contentIndex);
	const current = publicBlock(progress.block);
	const block = previous !== undefined && sameValue(current, previous) ? previous : freezeCapture(current);
	if (progress.phase === "insert") state.insertCopies.set(progress.contentIndex, block);
	else state.insertCopies.delete(progress.contentIndex);
	return Object.freeze({ ...progress, block });
}

/** Internal consumption is explicit; ordinary iterators are the downgrade boundary. Attached before the first push, it turns capture on. */
export function assistantRecords(source: AsyncIterable<AssistantMessageEvent>): AsyncIterable<AssistantRecord> {
	demanded.add(source);
	const read = readers.get(source);
	return {
		[Symbol.asyncIterator]: () =>
			read?.<AssistantRecord>((entry) => ({
				value: "event" in entry ? entry.event : entry.progress,
				done: false,
			})) ?? source[Symbol.asyncIterator](),
	};
}

/** Events only; each progress record goes to `onProgress` as it is read, so a forwarder spends no turn on it. */
export function assistantEvents(
	source: AsyncIterable<AssistantMessageEvent>,
	onProgress: (progress: AssistantProgress) => void,
): AsyncIterable<AssistantMessageEvent> {
	const read = readers.get(source);
	return {
		[Symbol.asyncIterator]: () =>
			read?.<AssistantMessageEvent>((entry) => {
				if ("event" in entry) return { value: entry.event, done: false };
				onProgress(entry.progress);
				return undefined;
			}) ?? source[Symbol.asyncIterator](),
	};
}

export function getAssistantCapture(event: object): AssistantCapture | undefined {
	return captures.get(event);
}

export function isAssistantProgress(event: AssistantRecord): event is AssistantProgress {
	return (
		event.type === "message_block_state" ||
		event.type === "message_block_metadata" ||
		event.type === "message_tool_arguments_reset"
	);
}

export interface CaptureHint {
	readonly rawArgumentPrefix?: string;
	readonly parsedThrough?: number;
	/** Replay deltas may begin before the bytes already covered by a deferred start. */
	readonly offset?: number;
}
export interface CapturePosition {
	offset: number;
	parsedThrough: number;
}

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
function sameValue(left: unknown, right: unknown): boolean {
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

export function dropAssistantCapture(event: object): void {
	if (capturedAny) captures.delete(event);
}

export function carryAssistantCapture<T extends object>(source: object, target: T, terminal?: AssistantMessage): T {
	const capture = captures.get(source);
	if (!capture) return target;
	try {
		captures.set(
			target,
			terminal
				? Object.freeze({
						...capture,
						message: freezeCapture({ ...terminal, content: terminal.content.map(publicBlock) }),
					})
				: capture,
		);
	} catch (error) {
		dropCapture(source, error);
	}
	return target;
}

/** Never parses or traverses a block on a delta, including a no-growth delta. */
export function captureAssistantEvent(owner: object, event: AssistantMessageEvent, hint: CaptureHint = {}): void {
	const state = activeState(owner);
	if (!state || captures.has(event)) return;
	const contentIndex = "contentIndex" in event ? event.contentIndex : undefined;
	if (contentIndex !== undefined && state.failedBlocks.has(contentIndex)) return;
	try {
		captures.set(event, buildCapture(state, event, hint));
	} catch (error) {
		dropCapture(owner, error, state, contentIndex);
	}
}

function buildCapture(state: CaptureState, event: AssistantMessageEvent, hint: CaptureHint): AssistantCapture {
	const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
	const usage = usageCopy(state, message.usage);
	if ("delta" in event) {
		const position = state.positions.get(event.contentIndex) ?? { offset: 0, parsedThrough: 0 };
		const offset = hint.offset ?? position.offset;
		position.offset = offset + event.delta.length;
		if (event.type === "toolcall_delta" && event.delta.length > 0) {
			position.parsedThrough = hint.parsedThrough ?? Math.max(position.parsedThrough, position.offset);
		}
		state.positions.set(event.contentIndex, position);
		return Object.freeze({
			usage,
			offset,
			...(event.type === "toolcall_delta" ? { parsedThrough: position.parsedThrough } : {}),
		});
	}
	const metadata = changedMetadata(state, message);
	if (!("contentIndex" in event)) {
		return Object.freeze({
			usage,
			metadata,
			message: freezeCapture({ ...message, content: message.content.map(publicBlock) }),
		});
	}
	const index = event.contentIndex;
	const block = freezeCapture(publicBlock(event.type === "toolcall_end" ? event.toolCall : message.content[index]));
	if (event.type !== "text_start" && event.type !== "thinking_start" && event.type !== "toolcall_start") {
		return Object.freeze({ usage, metadata, block });
	}
	const rawArgumentPrefix = hint.rawArgumentPrefix ?? "";
	const coveredCodeUnits =
		block.type === "text"
			? block.text.length
			: block.type === "thinking"
				? block.thinking.length
				: rawArgumentPrefix.length;
	const parsedThrough = hint.parsedThrough ?? 0;
	state.positions.set(index, { offset: hint.offset ?? coveredCodeUnits, parsedThrough });
	return Object.freeze({
		usage,
		metadata,
		block,
		coveredCodeUnits,
		...(block.type === "toolCall" ? { rawArgumentPrefix, parsedThrough } : {}),
	});
}

function usageCopy(state: CaptureState, usage: Usage): Usage {
	if (state.usage !== undefined && sameValue(usage, state.usage)) return state.usage;
	const copy = Object.freeze({
		...usage,
		cost: Object.freeze({ ...usage.cost }),
		...(usage.contextUsage ? { contextUsage: Object.freeze({ ...usage.contextUsage }) } : {}),
	});
	state.usage = copy;
	return copy;
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
