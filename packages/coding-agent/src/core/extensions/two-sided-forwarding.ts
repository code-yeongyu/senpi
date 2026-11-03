import type { JsonValue } from "@earendil-works/pi-ai";
import type { NestedRequest, PlaneHandler } from "@earendil-works/pi-agent-core";
import { EXTENSION_EVENT_PLACEMENT, isLoopSideEvent } from "./event-placement.ts";
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
 * whole where the loop runs, and the hand forwards each of that extension's undeclared `tool_call` / `tool_result`
 * handlers to it as a replied request on the call's nested plane, applying the returned result as if a local handler
 * had returned it. Handlers declared `runs: "hand"` stay on the hand, in their registration position.
 */
export const EXTENSION_EVENTS_PLANE = "extension-events";

type ToolEventType = "tool_call" | "tool_result";
type HandlerFn = NonNullable<ReturnType<Extension["handlers"]["get"]>>[number];

/** Where the hand sends one undeclared tool handler's event instead of running it locally. */
export interface ToolEventForwarder {
	readonly extensions: ReadonlySet<string>;
	toolCall(extension: string, handler: number, event: ToolCallEvent): Promise<ToolCallEventResult | undefined>;
	toolResult(extension: string, handler: number, event: ToolResultEvent): Promise<ToolResultEventResult | undefined>;
}

/** One forwarded handler: an extension's `handler`-th undeclared handler for the event, in registration order. */
export interface ForwardedHandler {
	readonly extension: string;
	readonly handler: number;
}

export interface ToolEventDispatchOptions {
	/** On the hand: forward the listed extensions' undeclared handlers instead of running them. */
	readonly forward?: ToolEventForwarder;
	/** Where the loop runs: run only this one handler (a forwarded request). */
	readonly only?: ForwardedHandler;
}

const undeclaredHandlers = (extension: Extension, event: ExtensionEvent["type"]): HandlerFn[] =>
	(extension.handlers.get(event) ?? []).filter((handler) => extension.handlerSides?.get(handler) === undefined);

const isPlacedEvent = (event: string): event is ExtensionEvent["type"] =>
	Object.hasOwn(EXTENSION_EVENT_PLACEMENT, event);

/**
 * The extensions whose undeclared registrations span loop-side events (`loop` or `split` in the event placement) and
 * tool events. Builtins are never forwarded: each side loads its own builtins, and their tool hooks (the permission
 * system among them) run on the hand by design (S27a).
 */
export function twoSidedExtensions(extensions: readonly Extension[]): Set<string> {
	const found = new Set<string>();
	for (const extension of extensions) {
		if (extension.path.startsWith("<builtin:")) continue;
		const events = [...extension.handlers.keys()].filter(isPlacedEvent);
		const registers = (event: ExtensionEvent["type"]): boolean => undeclaredHandlers(extension, event).length > 0;
		const tool = registers("tool_call") || registers("tool_result");
		const loop = events.some((event) => isLoopSideEvent(event) && registers(event));
		if (tool && loop) found.add(extension.path);
	}
	return found;
}

/**
 * The handlers one extension runs for a tool event, in registration order. Serving a forwarded request: only that one
 * undeclared handler. On the hand, for a forwarded extension: each undeclared handler becomes a forward of its ordinal,
 * and declared handlers stay local where they are. Otherwise: the extension's own handlers.
 */
export function toolEventHandlers(
	extension: Extension,
	event: ToolEventType,
	options: ToolEventDispatchOptions,
	forwardOne: (handler: number) => HandlerFn,
): HandlerFn[] {
	const own = extension.handlers.get(event)?.slice() ?? [];
	if (options.only !== undefined) {
		if (extension.path !== options.only.extension) return [];
		const target = undeclaredHandlers(extension, event)[options.only.handler];
		return target === undefined ? [] : [target];
	}
	if (options.forward?.extensions.has(extension.path) !== true) return own;
	let ordinal = 0;
	return own.map((handler) => (extension.handlerSides?.get(handler) === undefined ? forwardOne(ordinal++) : handler));
}

/** Whether the extension at `path` has an `handler`-th undeclared handler for `event` (a forwarded event's target). */
export function servesForwardedHandler(
	extensions: readonly Extension[],
	path: string,
	event: ToolEventType,
	handler: number,
): boolean {
	const extension = extensions.find((candidate) => candidate.path === path);
	return extension !== undefined && undeclaredHandlers(extension, event)[handler] !== undefined;
}

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The hand's forwarder for one running call: each request goes back to the loop that owns the call. */
export function forwardToolEvents(extensions: ReadonlySet<string>, nested: NestedRequest): ToolEventForwarder {
	return {
		extensions,
		async toolCall(extension, handler, event) {
			const body = json({ extension, handler, event: "tool_call", payload: event });
			const reply = await nested(EXTENSION_EVENTS_PLANE, body);
			if (!isRecord(reply)) return undefined;
			if (typeof reply.error === "string") throw new Error(reply.error);
			const input: Record<string, unknown> = event.input;
			if (isRecord(reply.input)) {
				for (const key of Object.keys(input)) delete input[key];
				Object.assign(input, reply.input);
			}
			return isRecord(reply.result) ? (reply.result as ToolCallEventResult) : undefined;
		},
		async toolResult(extension, handler, event) {
			const body = json({ extension, handler, event: "tool_result", payload: event });
			const reply = await nested(EXTENSION_EVENTS_PLANE, body);
			if (isRecord(reply) && typeof reply.error === "string") throw new Error(reply.error);
			return isRecord(reply) && isRecord(reply.result) ? (reply.result as ToolResultEventResult) : undefined;
		},
	};
}

const isOrdinal = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Where the loop runs: answers a forwarded tool event by running only that one handler in this generation. */
export function serveExtensionEvents(runner: ExtensionRunner): PlaneHandler {
	return async (body) => {
		if (!isRecord(body) || typeof body.extension !== "string" || !isRecord(body.payload) || !isOrdinal(body.handler))
			throw new Error("malformed extension event");
		if (body.event !== "tool_call" && body.event !== "tool_result")
			throw new Error(`unknown extension event ${String(body.event)}`);
		// Fail closed: the hand forwards only handlers its own copy has, so an extension here that lacks the same
		// undeclared handler is not the same extension, and running nothing would silently skip its hook.
		if (!runner.servesForwardedHandler(body.extension, body.event, body.handler))
			throw new Error(`extension ${body.extension} is not loaded where the loop runs`);
		const options = { only: { extension: body.extension, handler: body.handler } };
		try {
			if (body.event === "tool_call") {
				const event = body.payload as unknown as ToolCallEvent;
				const result = await runner.emitToolCall(event, options);
				return json({ result, input: event.input });
			}
			const result = await runner.emitToolResult(body.payload as unknown as ToolResultEvent, options);
			return json({ result });
		} catch (error) {
			// A handler's own failure is the event's answer, as a local handler's throw would be; only a broken request
			// fails the plane.
			return json({ error: error instanceof Error ? error.message : String(error) });
		}
	};
}
