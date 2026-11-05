import type { JsonValue, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentToolCall, AgentToolResult } from "../types.ts";
import type { AgentLoopConfig } from "../types.ts";
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

/** `owner[i]` is the segment that runs call `i`. */
function segmentsOf(
	calls: readonly AgentToolCall[],
	sideOf: (call: AgentToolCall) => Side,
	merge: boolean,
): { readonly segments: Segment[]; readonly owner: number[] } {
	const segments: Segment[] = [];
	const owner: number[] = [];
	for (const call of calls) {
		const side = sideOf(call);
		let index = merge ? segments.findIndex((segment) => segment.side === side) : segments.length - 1;
		if (index < 0 || segments[index]?.side !== side) index = segments.push({ side, calls: [] }) - 1;
		segments[index]?.calls.push(call);
		owner.push(index);
	}
	return { segments, owner };
}

/** Each segment's messages per call ID, in the order its host returned them (a batch may repeat an ID, senpi#5796). */
function queuesOf(results: readonly ToolHostResult[]): Map<string, ToolResultMessage[]>[] {
	return results.map((result) => {
		const queues = new Map<string, ToolResultMessage[]>();
		for (const message of result.messages) {
			const queue = queues.get(message.toolCallId) ?? [];
			queue.push(message);
			queues.set(message.toolCallId, queue);
		}
		return queues;
	});
}

/**
 * The ToolHost of a split session: each call to a loop-side tool runs on `loop` (the session's own pipeline, in its
 * process) and every other call on `hand`. A batch of one side goes to that host whole. A mixed batch keeps the mode:
 * `parallel` runs both sides at once, `sequential` runs each run of same-side calls in source order; the result messages
 * come back in the model's source order and the batch terminates only when every call asked to.
 */
export function createSplitToolHost(options: {
	readonly loopSide: (toolName: string) => boolean;
	readonly loop: ToolHost;
	readonly hand: ToolHost;
}): ToolHost {
	const sideOf = (call: AgentToolCall): Side => (options.loopSide(call.name) ? "loop" : "hand");
	const hostOf = (side: Side): ToolHost => (side === "loop" ? options.loop : options.hand);

	return {
		async execute(call: ToolHostCall, hostOptions: ToolHostOptions): Promise<ToolHostResult> {
			const { segments, owner } = segmentsOf(call.calls, sideOf, call.mode === "parallel");
			const [only] = segments;
			if (segments.length <= 1) return hostOf(only?.side ?? "hand").execute(call, hostOptions);

			const run = (segment: Segment) => hostOf(segment.side).execute({ ...call, calls: segment.calls }, hostOptions);
			const results: ToolHostResult[] = [];
			if (call.mode === "parallel") results.push(...(await Promise.all(segments.map(run))));
			else for (const segment of segments) results.push(await run(segment));

			const queues = queuesOf(results);
			return {
				messages: call.calls.flatMap((raw, index) => queues[owner[index] ?? -1]?.get(raw.id)?.shift() ?? []),
				terminate: results.every((result) => result.terminate),
			};
		},
	};
}
