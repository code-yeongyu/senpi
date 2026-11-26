import type { JsonValue, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentToolCall, AgentToolResult } from "../types.ts";
import type { AgentEvent, AgentLoopConfig } from "../types.ts";
import { type NestedRequest, type PlaneHandler, PlaneRefusedError } from "./plane.ts";
import { createPreparedToolHost } from "./prepared/pipeline-prepared.ts";
import {
	BatchStoreMissingError,
	PreflightCarryMissingError,
	type ToolHost,
	type ToolHostCall,
	type ToolHostOptions,
	type ToolHostResult,
} from "./tool-host.ts";

/**
 * The session plane (brain/hand split, S32): tools that act on the session (todo, thread tools, task/subagent spawn,
 * `ask_user`, and the other built-ins declared `runs: "brain"`) run where the loop runs. A model call to one of them
 * never reaches the hand, and a hand-run tool that needs one asks the brain that owns its call on this plane.
 */
export const SESSION_PLANE = "session";

/** One loop-side tool call a hand-run tool asks the brain for. */
export interface SessionPlaneRequest {
	readonly tool: string;
	readonly arguments: Readonly<Record<string, unknown>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses a request body, keeping only the fields of {@link SessionPlaneRequest}; refuses a malformed one. */
export function decodeSessionPlaneRequest(body: unknown): SessionPlaneRequest {
	if (!isRecord(body) || typeof body.tool !== "string" || body.tool.length === 0)
		throw new PlaneRefusedError("malformed_request: tool");
	if (!isRecord(body.arguments)) throw new PlaneRefusedError("malformed_request: arguments");
	return { tool: body.tool, arguments: body.arguments };
}

/** The registered tools a split session runs loop-side: exactly those declared `runs: "brain"`. */
export function loopSideToolNames(
	tools: Iterable<{ readonly name: string; readonly runs?: "brain" | "hand" }>,
): ReadonlySet<string> {
	const names = new Set<string>();
	for (const tool of tools) if (tool.runs === "brain") names.add(tool.name);
	return names;
}

/**
 * The brain's session plane: runs one loop-side tool call with the session's own tools and returns its result. A tool
 * that is not loop-side is refused `not_loop_side`: a hand's tools never run on the brain through this plane.
 */
export function serveSessionPlane(options: {
	readonly loopSide: ReadonlySet<string>;
	readonly run: (request: SessionPlaneRequest, signal: AbortSignal) => Promise<AgentToolResult<unknown>>;
}): PlaneHandler {
	return async (body, signal) => {
		const request = decodeSessionPlaneRequest(body);
		if (!options.loopSide.has(request.tool)) throw new Error(`not_loop_side: ${request.tool}`);
		const result = await options.run(request, signal);
		return JSON.parse(JSON.stringify(result)) as JsonValue;
	};
}

/** A hand's client for the session plane, over the running call's nested requests. */
export function createSessionPlaneClient(nested: NestedRequest) {
	return {
		async call(request: SessionPlaneRequest, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
			const reply = await nested(SESSION_PLANE, JSON.parse(JSON.stringify(request)) as JsonValue, signal);
			if (!isRecord(reply) || !Array.isArray(reply.content)) throw new PlaneRefusedError("malformed_reply");
			return reply as unknown as AgentToolResult<unknown>;
		},
	};
}

type LoopToolSource = Pick<
	AgentLoopConfig,
	| "resolveUnknownToolCall"
	| "beforeToolCall"
	| "afterToolCall"
	| "removedToolHints"
	| "afterToolFreeze"
	| "batchStoreFactory"
>;

/**
 * The loop's own pipeline as a ToolHost (the prepared pipeline a fused session runs), for a split session's loop-side
 * calls. It reads `agent`'s hooks and batch store at each batch, so hooks installed after it was made still apply.
 */
export function createLoopToolHost(agent: LoopToolSource): ToolHost {
	return {
		execute(call, options) {
			const { batchStoreFactory, afterToolFreeze } = agent;
			if (batchStoreFactory === undefined) throw new BatchStoreMissingError();
			if (afterToolFreeze === undefined) throw new PreflightCarryMissingError();
			return createPreparedToolHost({ ...pick(agent), afterToolFreeze }, batchStoreFactory).execute(call, options);
		},
	};
}

function pick(agent: LoopToolSource) {
	return {
		resolveUnknownToolCall: agent.resolveUnknownToolCall,
		beforeToolCall: agent.beforeToolCall,
		afterToolCall: agent.afterToolCall,
		removedToolHints: agent.removedToolHints,
	};
}

type Side = "loop" | "hand";

interface Segment {
	readonly side: Side;
	readonly calls: AgentToolCall[];
}

/**
 * Splits a batch into stages run one after another, each a set of same-side segments run at once; `owner[i]` is the
 * segment that runs call `i`. `parallel` keeps the loop's dependency order (`batchDependencies`): a sequential call is a
 * stage of its own, so it waits for every earlier call and every later call waits for it; the calls between two
 * sequential calls share one stage. Otherwise each run of same-side calls is a stage.
 */
function stagesOf(
	calls: readonly AgentToolCall[],
	sideOf: (call: AgentToolCall) => Side,
	isSequential: (call: AgentToolCall) => boolean,
	parallel: boolean,
): { readonly stages: Segment[][]; readonly segments: Segment[]; readonly owner: number[] } {
	const stages: Segment[][] = [];
	const segments: Segment[] = [];
	const owner: number[] = [];
	let open = false;
	for (const call of calls) {
		const side = sideOf(call);
		const barrier = parallel && isSequential(call);
		const stage = stages.at(-1);
		const joinable = open && !barrier && stage !== undefined && (parallel || stage[0]?.side === side);
		if (!joinable) stages.push([]);
		const current = stages.at(-1) ?? [];
		let segment = current.find((entry) => entry.side === side);
		if (segment === undefined) {
			segment = { side, calls: [] };
			current.push(segment);
			segments.push(segment);
		}
		segment.calls.push(call);
		owner.push(segments.indexOf(segment));
		open = !barrier;
	}
	return { stages, segments, owner };
}

/** Items per call ID in arrival order (a batch may repeat an ID, senpi#5796). */
function queueBy<T>(items: readonly T[], idOf: (item: T) => string): Map<string, T[]> {
	const queues = new Map<string, T[]>();
	for (const item of items) {
		const queue = queues.get(idOf(item)) ?? [];
		queue.push(item);
		queues.set(idOf(item), queue);
	}
	return queues;
}

/** A tool result message's `message_start`/`message_end` pair, held back so a parallel batch emits them in source order. */
interface HeldResult {
	readonly toolCallId: string;
	readonly events: AgentEvent[];
}

/** Passes every event through except tool result messages, which it holds in `held` as start/end pairs. */
function holdingResults(emit: ToolHostOptions["emit"], held: HeldResult[]): ToolHostOptions["emit"] {
	return (event) => {
		if ((event.type !== "message_start" && event.type !== "message_end") || event.message.role !== "toolResult")
			return emit(event);
		const { toolCallId } = event.message;
		const open = event.type === "message_end" ? held.findLast((entry) => entry.toolCallId === toolCallId) : undefined;
		if (open !== undefined && open.events.at(-1)?.type === "message_start") open.events.push(event);
		else held.push({ toolCallId, events: [event] });
	};
}

/**
 * The ToolHost of a split session: each call to a loop-side tool runs on `loop` (the session's own pipeline, in its
 * process) and every other call on `hand`. A batch of one side goes to that host whole. A mixed batch keeps the mode:
 * `parallel` runs both sides at once and emits the result messages in source order once both finished, as the fused
 * pipeline does; `sequential` runs each run of same-side calls in source order and starts none after an abort. Results come
 * back in the model's source order and the batch terminates only when every call asked to.
 */
export function createSplitToolHost(options: {
	readonly loopSide: (toolName: string) => boolean;
	/** The tools declared `executionMode: "sequential"`: in a parallel batch each waits for every earlier call. */
	readonly isSequential: (toolName: string) => boolean;
	readonly loop: ToolHost;
	readonly hand: ToolHost;
}): ToolHost {
	const sideOf = (call: AgentToolCall): Side => (options.loopSide(call.name) ? "loop" : "hand");
	const isSequential = (call: AgentToolCall): boolean => options.isSequential(call.name);
	const hostOf = (side: Side): ToolHost => (side === "loop" ? options.loop : options.hand);

	return {
		async execute(call: ToolHostCall, hostOptions: ToolHostOptions): Promise<ToolHostResult> {
			const parallel = call.mode === "parallel";
			const { stages, segments, owner } = stagesOf(call.calls, sideOf, isSequential, parallel);
			const [only] = segments;
			if (segments.every((segment) => segment.side === only?.side))
				return hostOf(only?.side ?? "hand").execute(call, hostOptions);

			const held: HeldResult[][] = segments.map(() => []);
			const run = async (segment: Segment): Promise<void> => {
				const index = segments.indexOf(segment);
				results[index] = await hostOf(segment.side).execute(
					{ ...call, calls: segment.calls },
					parallel ? { ...hostOptions, emit: holdingResults(hostOptions.emit, held[index] ?? []) } : hostOptions,
				);
			};
			const results: Array<ToolHostResult | undefined> = segments.map(() => undefined);
			for (const stage of stages) {
				await Promise.all(stage.map(run));
				if (hostOptions.signal?.aborted) break;
			}

			const messages = results.map((result) => queueBy(result?.messages ?? [], (message) => message.toolCallId));
			const events = held.map((entries) => queueBy(entries, (entry) => entry.toolCallId));
			const ordered: ToolResultMessage[] = [];
			for (const [index, raw] of call.calls.entries()) {
				const segment = owner[index] ?? -1;
				for (const event of events[segment]?.get(raw.id)?.shift()?.events ?? []) await hostOptions.emit(event);
				const message = messages[segment]?.get(raw.id)?.shift();
				if (message !== undefined) ordered.push(message);
			}
			const ran = results.filter((result): result is ToolHostResult => (result?.messages.length ?? 0) > 0);
			return {
				messages: ordered,
				// As the fused pipeline: only segments whose calls ran decide; a batch where nothing ran does not terminate.
				terminate: ran.length > 0 && ran.every((result) => result.terminate),
			};
		},
	};
}
