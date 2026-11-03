import type { JsonValue } from "@earendil-works/pi-ai";
import type { Transport } from "../transport/transport.ts";

/**
 * Nested requests from a hand back to the brain that owns the running call (brain/hand split, design 5.6.3): a
 * model-backed tool's completion (S31) and, later, session-plane work. A request travels on its parent call's own scope
 * lane and names that parent; the brain admits it only while the parent is live on that lane, and it is never sent
 * hand-to-hand. The bodies are a plane's own payloads; this layer only carries, admits, deduplicates and cancels them.
 */
export type PlaneMessage = PlaneRequest | PlaneAbort | PlaneReply | PlaneRefused;

interface PlaneAddress {
	/** The execution ID of the call the request is nested in. */
	readonly parent: string;
	/** Unique per parent; a replayed request with the same ID gets the same answer and is served once. */
	readonly childRequestId: string;
}

export interface PlaneRequest extends PlaneAddress {
	readonly kind: "plane.request";
	readonly plane: string;
	readonly body: JsonValue;
}

export interface PlaneAbort extends PlaneAddress {
	readonly kind: "plane.abort";
}

export interface PlaneReply extends PlaneAddress {
	readonly kind: "plane.reply";
	readonly body: JsonValue;
}

/**
 * The brain did not serve the request. `parent_terminal`: its parent is not a live call; `scope_lane_mismatch`: it came
 * on another scope's lane; `plane_unavailable`: the brain serves no such plane; `plane_failed: ...`: the plane's
 * handler failed.
 */
export interface PlaneRefused extends PlaneAddress {
	readonly kind: "plane.refused";
	readonly reason: string;
}

/** Serves one plane on the brain. `signal` aborts when the request or its parent call is aborted or ends. */
export type PlaneHandler = (body: JsonValue, signal: AbortSignal) => Promise<JsonValue>;

/** What a running call on a hand uses to ask the brain that owns it. Rejects with {@link PlaneRefusedError}. */
export type NestedRequest = (plane: string, body: JsonValue, signal?: AbortSignal) => Promise<JsonValue>;

export class PlaneRefusedError extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(`The brain refused this request: ${reason}`);
		this.name = "PlaneRefusedError";
		this.reason = reason;
	}
}

const KINDS: readonly PlaneMessage["kind"][] = ["plane.request", "plane.abort", "plane.reply", "plane.refused"];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodePlaneMessage(message: PlaneMessage): Uint8Array {
	return encoder.encode(JSON.stringify(message));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Parses one frame payload as a plane message; anything else (a tool-call message included) is `undefined`. */
export function decodePlaneMessage(payload: Uint8Array): PlaneMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(payload));
	} catch {
		return undefined;
	}
	if (!isRecord(value) || !KINDS.includes(value.kind as PlaneMessage["kind"])) return undefined;
	if (!isId(value.parent) || !isId(value.childRequestId)) return undefined;
	const address = { parent: value.parent, childRequestId: value.childRequestId };
	switch (value.kind) {
		case "plane.request":
			return isId(value.plane) && "body" in value
				? { kind: "plane.request", ...address, plane: value.plane, body: value.body as JsonValue }
				: undefined;
		case "plane.abort":
			return { kind: "plane.abort", ...address };
		case "plane.reply":
			return "body" in value ? { kind: "plane.reply", ...address, body: value.body as JsonValue } : undefined;
		default:
			return typeof value.reason === "string"
				? { kind: "plane.refused", ...address, reason: value.reason }
				: undefined;
	}
}

interface Served {
	readonly controller: AbortController;
	answer?: PlaneMessage;
}

/**
 * The brain's side: admits a request only while its parent is a live call on the lane it came on, serves each
 * (parent, child request) once and answers a replay from the stored answer, and aborts a parent's open requests when
 * the parent ends. Answers are kept for the parent's life only.
 */
export function createPlaneServer(options: {
	readonly transport: Transport;
	readonly planes: Readonly<Record<string, PlaneHandler>>;
	/** The lane of the live call with this execution ID, or `undefined` once it ended (or never existed). */
	readonly liveLane: (executionId: string) => string | undefined;
}) {
	const served = new Map<string, Map<string, Served>>();
	const send = (lane: string, message: PlaneMessage): void =>
		void options.transport.send(lane, encodePlaneMessage(message)).catch(() => undefined);

	const serve = (lane: string, request: PlaneRequest): void => {
		const { parent, childRequestId } = request;
		const refuse = (reason: string): void => send(lane, { kind: "plane.refused", parent, childRequestId, reason });
		const parentLane = options.liveLane(parent);
		if (parentLane === undefined) return refuse("parent_terminal");
		if (parentLane !== lane) return refuse("scope_lane_mismatch");
		const children = served.get(parent) ?? new Map<string, Served>();
		served.set(parent, children);
		const known = children.get(childRequestId);
		if (known !== undefined) {
			if (known.answer !== undefined) send(lane, known.answer);
			return;
		}
		const handler = Object.hasOwn(options.planes, request.plane) ? options.planes[request.plane] : undefined;
		if (handler === undefined) return refuse("plane_unavailable");
		const entry: Served = { controller: new AbortController() };
		children.set(childRequestId, entry);
		void handler(request.body, entry.controller.signal)
			.then(
				(body): PlaneMessage => ({ kind: "plane.reply", parent, childRequestId, body }),
				(error: unknown): PlaneMessage => ({
					kind: "plane.refused",
					parent,
					childRequestId,
					reason: `plane_failed: ${error instanceof Error ? error.message : String(error)}`,
				}),
			)
			.then((answer) => {
				if (served.get(parent)?.get(childRequestId) !== entry) return;
				entry.answer = answer;
				send(lane, answer);
			});
	};

	return {
		receive(lane: string, message: PlaneMessage): void {
			if (message.kind === "plane.request") serve(lane, message);
			else if (message.kind === "plane.abort")
				served.get(message.parent)?.get(message.childRequestId)?.controller.abort();
		},
		parentEnded(executionId: string): void {
			const children = served.get(executionId);
			served.delete(executionId);
			for (const entry of children?.values() ?? []) entry.controller.abort();
		},
	};
}

interface Waiting {
	readonly resolve: (body: JsonValue) => void;
	readonly reject: (error: Error) => void;
}

/** The hand's side: issues a running call's nested requests on its lane and fails them all once the call ends. */
export function createPlaneClient(options: { readonly transport: Transport; readonly mintId?: () => string }) {
	const mintId = options.mintId ?? (() => crypto.randomUUID());
	const waiting = new Map<string, Map<string, Waiting>>();
	const ended = new Set<string>();

	return {
		requestFor(parent: string, lane: string, parentSignal: AbortSignal): NestedRequest {
			return (plane, body, signal) =>
				new Promise<JsonValue>((resolve, reject) => {
					if (ended.has(parent) || parentSignal.aborted || signal?.aborted)
						return reject(new PlaneRefusedError("parent_terminal"));
					const childRequestId = mintId();
					const children = waiting.get(parent) ?? new Map<string, Waiting>();
					waiting.set(parent, children);
					const abort = (): void => {
						if (!children.delete(childRequestId)) return;
						void options.transport
							.send(lane, encodePlaneMessage({ kind: "plane.abort", parent, childRequestId }))
							.catch(() => undefined);
						reject(new Error("Operation aborted"));
					};
					const release = (): void => {
						parentSignal.removeEventListener("abort", abort);
						signal?.removeEventListener("abort", abort);
					};
					children.set(childRequestId, {
						resolve: (value) => {
							release();
							resolve(value);
						},
						reject: (error) => {
							release();
							reject(error);
						},
					});
					parentSignal.addEventListener("abort", abort, { once: true });
					signal?.addEventListener("abort", abort, { once: true });
					const request: PlaneMessage = { kind: "plane.request", parent, childRequestId, plane, body };
					options.transport.send(lane, encodePlaneMessage(request)).catch((error: unknown) => {
						if (!children.delete(childRequestId)) return;
						release();
						reject(
							new PlaneRefusedError(
								`brain_unreachable: ${error instanceof Error ? error.message : String(error)}`,
							),
						);
					});
				});
		},
		receive(message: PlaneMessage): void {
			if (message.kind !== "plane.reply" && message.kind !== "plane.refused") return;
			const children = waiting.get(message.parent);
			const waiter = children?.get(message.childRequestId);
			if (waiter === undefined) return;
			children?.delete(message.childRequestId);
			if (message.kind === "plane.reply") waiter.resolve(message.body);
			else waiter.reject(new PlaneRefusedError(message.reason));
		},
		parentEnded(parent: string): void {
			ended.add(parent);
			const children = waiting.get(parent);
			waiting.delete(parent);
			for (const waiter of children?.values() ?? []) waiter.reject(new PlaneRefusedError("parent_terminal"));
		},
	};
}
