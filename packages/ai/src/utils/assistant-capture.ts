import type { AssistantMessage, AssistantMessageEvent, Usage } from "../types.ts";

type PublicBlock = AssistantMessage["content"][number];
export type AssistantProgress =
	| { type: "message_block_state"; contentIndex: number; phase: "insert" | "end"; block: PublicBlock }
	| {
			type: "message_block_metadata";
			contentIndex: number;
			/** Appends to the signature; `thinkingSignature` and `textSignature` replace it. */
			thinkingSignatureDelta?: string;
			thinkingSignature?: string;
			textSignature?: string;
			redacted?: true;
			name?: string;
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
	/** The block's own index where the event's public `contentIndex` names another block; internal readers prefer it. */
	readonly contentIndex?: number;
	/**
	 * First block index whose earlier records no longer name the terminal's blocks (block index/identity only); readers
	 * MUST drop every block record at or above it for that message; absent = no rewrite. The terminal message always
	 * wins for CONTENT: readers replace each block's content from the terminal (or the block's end event), never
	 * append-only from live records.
	 */
	readonly rewrittenFrom?: number;
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

/** A text or thinking signature replaced without a public event; an unchanged or empty one records nothing. */
export function pushAssistantSignature(
	owner: object,
	contentIndex: number,
	block: Extract<PublicBlock, { type: "text" | "thinking" }>,
	signature: string | undefined,
): void {
	if (!signature || signature === (block.type === "text" ? block.textSignature : block.thinkingSignature)) return;
	pushAssistantProgress(owner, {
		type: "message_block_metadata",
		contentIndex,
		...(block.type === "text" ? { textSignature: signature } : { thinkingSignature: signature }),
	});
}

/** A block appended complete with no public event: its unchanged end reuses the insert's frozen copy. */
export function pushAssistantCompleteBlock(owner: object, contentIndex: number, block: PublicBlock): void {
	for (const phase of ["insert", "end"] as const)
		pushAssistantProgress(owner, { type: "message_block_state", contentIndex, phase, block });
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

/** Internal readers address a block by `capture.contentIndex ?? event.contentIndex`; the public index can drift (Google/Vertex). */
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
	/** The open block's own index when the adapter's public `contentIndex` has drifted from it. */
	readonly contentIndex?: number;
	/**
	 * Set by a wrapper that re-emits a source event 1:1 at its own index while reading the source later than it was
	 * emitted: block facts come from this source capture, usage and metadata from the relaying stream. `null` records
	 * nothing, because the source captured nothing.
	 */
	readonly carried?: AssistantCapture | null;
	/** A terminal's `AssistantCapture.rewrittenFrom`. */
	readonly rewrittenFrom?: number;
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
		captures.set(target, terminal ? terminalCapture(capture, terminal) : capture);
	} catch (error) {
		dropCapture(source, error);
	}
	return target;
}

/** A terminal replaced downstream: its usage and message, plus every scalar that differs from the source terminal. */
function terminalCapture(capture: AssistantCapture, terminal: AssistantMessage): AssistantCapture {
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

/** Never parses or traverses a block on a delta, including a no-growth delta. */
export function captureAssistantEvent(owner: object, event: AssistantMessageEvent, hint: CaptureHint = {}): void {
	const state = activeState(owner);
	// A relay of a source that captured nothing, or captured a drifted index, gets no record: lack, never wrong.
	if (!state || captures.has(event) || hint.carried === null || hint.carried?.contentIndex !== undefined) return;
	const contentIndex = "contentIndex" in event ? (hint.contentIndex ?? event.contentIndex) : undefined;
	if (contentIndex !== undefined && state.failedBlocks.has(contentIndex)) return;
	try {
		const capture = buildCapture(state, event, hint);
		if (capture) captures.set(event, capture);
	} catch (error) {
		dropCapture(owner, error, state, contentIndex);
	}
}

function buildCapture(
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
	state.positions.set(index, { offset: hint.offset ?? coveredCodeUnits, parsedThrough });
	return Object.freeze({
		usage,
		metadata,
		block,
		coveredCodeUnits,
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
