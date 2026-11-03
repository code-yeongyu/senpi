import type { JsonValue } from "@earendil-works/pi-ai";
import type { NestedRequest, PlaneHandler } from "@earendil-works/pi-agent-core";
import type { ExtensionRunner } from "./runner.ts";
import type {
	Extension,
	ExtensionEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "./types.ts";

/**
 * Two-sided extensions on a split session (brain/hand split S29, decision C7(c)). An extension that registers both loop
 * events and tool events, and declares no side, keeps one in-memory state only if all of it runs in one process: it runs
 * whole where the loop runs, and the hand forwards that extension's `tool_call` / `tool_result` events to it as
 * replied requests on the call's nested plane, applying the returned result as if a local handler had returned it.
 */
export const EXTENSION_EVENTS_PLANE = "extension-events";

const TOOL_EVENTS = new Set<ExtensionEvent["type"]>(["tool_call", "tool_result"]);
const LOOP_EVENTS = new Set<ExtensionEvent["type"]>([
	"agent_end",
	"agent_start",
	"before_agent_start",
	"before_provider_request",
	"context",
	"input",
	"message_end",
	"message_start",
	"session_start",
	"turn_end",
	"turn_start",
]);

/** Where the hand sends one extension's tool events instead of running its handlers locally. */
export interface ToolEventForwarder {
	readonly extensions: ReadonlySet<string>;
	toolCall(extension: string, event: ToolCallEvent): Promise<ToolCallEventResult | undefined>;
	toolResult(extension: string, event: ToolResultEvent): Promise<ToolResultEventResult | undefined>;
}

export interface ToolEventDispatchOptions {
	/** On the hand: forward the listed extensions' handlers instead of running them. */
	readonly forward?: ToolEventForwarder;
	/** Where the loop runs: run only this extension's handlers (a forwarded request). */
	readonly only?: string;
}

const undeclared = (extension: Extension, event: ExtensionEvent["type"]): boolean =>
	(extension.handlers.get(event) ?? []).some((handler) => extension.handlerSides?.get(handler) === undefined);

/**
 * The extensions whose undeclared registrations span loop events and tool events. Builtins are never forwarded: each
 * side loads its own builtins, and their tool hooks (the permission system among them) run on the hand by design (S27a).
 */
export function twoSidedExtensions(extensions: readonly Extension[]): Set<string> {
	const found = new Set<string>();
	for (const extension of extensions) {
		if (extension.path.startsWith("<builtin:")) continue;
		const tool = [...TOOL_EVENTS].some((event) => undeclared(extension, event));
		const loop = [...LOOP_EVENTS].some((event) => undeclared(extension, event));
		if (tool && loop) found.add(extension.path);
	}
	return found;
}

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The hand's forwarder for one running call: each request goes back to the loop that owns the call. */
export function forwardToolEvents(extensions: ReadonlySet<string>, nested: NestedRequest): ToolEventForwarder {
	return {
		extensions,
		async toolCall(extension, event) {
			const reply = await nested(EXTENSION_EVENTS_PLANE, json({ extension, event: "tool_call", payload: event }));
			if (!isRecord(reply)) return undefined;
			if (typeof reply.error === "string") throw new Error(reply.error);
			const input: Record<string, unknown> = event.input;
			if (isRecord(reply.input)) {
				for (const key of Object.keys(input)) delete input[key];
				Object.assign(input, reply.input);
			}
			return isRecord(reply.result) ? (reply.result as ToolCallEventResult) : undefined;
		},
		async toolResult(extension, event) {
			const reply = await nested(EXTENSION_EVENTS_PLANE, json({ extension, event: "tool_result", payload: event }));
			if (isRecord(reply) && typeof reply.error === "string") throw new Error(reply.error);
			return isRecord(reply) && isRecord(reply.result) ? (reply.result as ToolResultEventResult) : undefined;
		},
	};
}

/** Where the loop runs: answers a forwarded tool event by running only that extension's handlers in this generation. */
export function serveExtensionEvents(runner: ExtensionRunner): PlaneHandler {
	return async (body) => {
		if (!isRecord(body) || typeof body.extension !== "string" || !isRecord(body.payload))
			throw new Error("malformed extension event");
		// Fail closed: the hand forwards an event only for handlers its own copy has, so an extension here that lacks
		// them is not the same extension, and running nothing would silently skip its hook.
		if (
			(body.event !== "tool_call" && body.event !== "tool_result") ||
			!runner.extensionHandles(body.extension, body.event)
		)
			throw new Error(`extension ${body.extension} is not loaded where the loop runs`);
		const options = { only: body.extension };
		try {
			if (body.event === "tool_call") {
				const event = body.payload as unknown as ToolCallEvent;
				const result = await runner.emitToolCall(event, options);
				return json({ result, input: event.input });
			}
			if (body.event === "tool_result") {
				const result = await runner.emitToolResult(body.payload as unknown as ToolResultEvent, options);
				return json({ result });
			}
		} catch (error) {
			// A handler's own failure is the event's answer, as a local handler's throw would be; only a broken request
			// fails the plane.
			return json({ error: error instanceof Error ? error.message : String(error) });
		}
		throw new Error(`unknown extension event ${String(body.event)}`);
	};
}
