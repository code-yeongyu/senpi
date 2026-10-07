import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which session - and which of its tools - the host event loop is working for.
 *
 * Every in-process session shares one loop, so a stall observed by the loop-lag
 * watchdog has to be attributed to the work that was running, not to the host at
 * large. Attribution is carried in `AsyncLocalStorage` (so anything an attributed
 * command starts can read it) and mirrored in a process-local activity registry the
 * watchdog can sample from a timer callback, where the async context of the blocked
 * work is long gone.
 */
export interface SessionAttribution {
	/** Routing handle of the session this work belongs to. */
	readonly sessionId?: string;
	/** Tool currently executing for that session. */
	readonly tool?: string;
}

const attributionStore = new AsyncLocalStorage<SessionAttribution>();

/**
 * Monotonic activity counter. Ordering is all the watchdog needs - it samples the mark
 * on every tick and asks what ran since - so the registry never reads a clock and stays
 * deterministic under fake timers.
 */
let sequence = 0;
/** Attributed work that is still running, keyed by its sequence number (ascending). */
const openActivities = new Map<number, SessionAttribution>();
/** The most recent synchronous activity that has finished. */
let lastFinished: { readonly sequence: number; readonly attribution: SessionAttribution } | undefined;

/**
 * Run `task` attributed to `attribution`: its async chain reads the attribution from
 * `AsyncLocalStorage`, and the work stays blamable for as long as it is IN FLIGHT.
 *
 * The whole lifetime matters, not just the first synchronous segment: a routed command
 * almost never blocks the loop before its first await - an extension request, a tool, a
 * turn all block in a later continuation, by which time a synchronous-only registration
 * has already been retired (observed on a live host: `no attributed session` for a
 * 1.7 s stall caused by one session's extension request).
 */
export function runWithSessionAttribution<T>(attribution: SessionAttribution, task: () => T): T {
	const mark = ++sequence;
	openActivities.set(mark, attribution);
	const finish = (): void => {
		if (!openActivities.delete(mark)) return;
		lastFinished = { sequence: ++sequence, attribution };
	};
	let awaited = false;
	try {
		const result = attributionStore.run(attribution, task);
		if (isPromiseLike(result)) {
			awaited = true;
			// Settlement of a COPY: the caller still receives (and must handle) the
			// original rejection - this branch only ends the attribution window.
			void Promise.resolve(result).then(finish, finish);
		}
		return result;
	} finally {
		if (!awaited) finish();
	}
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

/**
 * Open-ended attribution for work that outlives its dispatch, i.e. a tool executing
 * inside a turn. The span inherits the ambient session id when the caller does not
 * name one, and stays blamable until the returned disposer runs.
 */
export function openSessionAttributionSpan(attribution: SessionAttribution): () => void {
	const ambient = attributionStore.getStore();
	const merged: SessionAttribution = {
		sessionId: attribution.sessionId ?? ambient?.sessionId,
		tool: attribution.tool,
	};
	const mark = ++sequence;
	openActivities.set(mark, merged);
	return () => {
		if (!openActivities.delete(mark)) return;
		lastFinished = { sequence: ++sequence, attribution: merged };
	};
}

/** Current activity counter; the watchdog samples it once per tick. */
export function sessionActivityMark(): number {
	return sequence;
}

/**
 * The activity to blame for work that ran after `mark`. A synchronous body that
 * finished inside the window wins (it is the code that just held the loop); otherwise
 * the newest open span - a tool mid-execution - takes the blame. Neither means the
 * stall belongs to the host itself, and the record is emitted without a session.
 */
export function sessionActivitySince(mark: number): SessionAttribution | undefined {
	if (lastFinished !== undefined && lastFinished.sequence > mark) return lastFinished.attribution;
	let newest: SessionAttribution | undefined;
	for (const attribution of openActivities.values()) newest = attribution;
	return newest;
}

/** Tool spans of one session, driven by the records its runtime emits. */
export interface ToolAttributionSpans {
	/** Inspect one session record; tool execution records open and close spans. */
	observe(record: object): void;
	/** Close every span of this session (turn settled, or the binding went away). */
	closeAll(): void;
}

function toolRecord(record: object): { type: string; toolCallId?: string; toolName?: string } | undefined {
	if (!("type" in record) || typeof record.type !== "string") return undefined;
	return {
		type: record.type,
		toolCallId: "toolCallId" in record && typeof record.toolCallId === "string" ? record.toolCallId : undefined,
		toolName: "toolName" in record && typeof record.toolName === "string" ? record.toolName : undefined,
	};
}

/**
 * Track which tool a session is executing, from the record stream its runtime already
 * produces. In-process sessions run their tools ON the host loop, so this is where a
 * blocking tool becomes attributable; worker sessions block their own isolate and
 * deliberately have no spans here.
 */
export function createToolAttributionSpans(sessionId: string): ToolAttributionSpans {
	const spans = new Map<string, () => void>();
	const closeAll = (): void => {
		for (const close of spans.values()) close();
		spans.clear();
	};
	return {
		closeAll,
		observe: (record) => {
			const parsed = toolRecord(record);
			if (parsed === undefined) return;
			if (parsed.type === "tool_execution_start" && parsed.toolCallId !== undefined) {
				spans.get(parsed.toolCallId)?.();
				spans.set(parsed.toolCallId, openSessionAttributionSpan({ sessionId, tool: parsed.toolName }));
				return;
			}
			if (parsed.type === "tool_execution_end" && parsed.toolCallId !== undefined) {
				spans.get(parsed.toolCallId)?.();
				spans.delete(parsed.toolCallId);
				return;
			}
			// A settled turn cannot still be inside a tool: release whatever is left, so a
			// tool whose end record never arrived cannot keep taking the blame forever.
			if (parsed.type === "agent_settled" || parsed.type === "agent_idle") closeAll();
		},
	};
}
