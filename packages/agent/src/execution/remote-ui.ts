import type { JsonValue } from "@earendil-works/pi-ai";
import { type NestedRequest, type PlaneHandler, PlaneRefusedError } from "./plane.ts";

/**
 * Remote dialogs (brain/hand split, S26b, C5.c). A dialog an extension raises on a hand while it runs a call (a select,
 * confirm or input: a permission prompt, an MCP elicitation, a sign-in code) is asked by the loop that
 * owns the call, on the call's nested plane, so it becomes a pending dialog of that loop's session and anyone who may
 * answer it there (an attached client, another session or agent over RPC) can. The hand waits for the answer.
 *
 * Exactly-once comes from the plane: the brain serves each (parent, request) once and answers a replay from the stored
 * answer, and the dialog is aborted when the request is aborted or its parent call ends (a hand killed mid-dialog ends
 * the call), so an answer that arrives later finds nothing pending and is refused where it is sent.
 */
export const UI_DIALOG_PLANE = "ui-dialog";

/** The dialogs a hand asks the loop for. Each answers one JSON value, or nothing (`undefined`). */
export const DIALOG_METHODS = ["select", "confirm", "input"] as const;
export type DialogMethod = (typeof DIALOG_METHODS)[number];

export interface DialogRequest {
	readonly method: DialogMethod;
	/** The dialog's own arguments without its options object (title, choices, message, placeholder). */
	readonly args: readonly JsonValue[];
	/** The dialog's timeout, when it has one: the loop's UI shows it; the hand enforces it. */
	readonly timeoutMs?: number;
}

/** The loop's answer: the dialog settled with `value`, or with nothing (`undefined`: cancelled, dismissed). */
export type DialogAnswer = { readonly value: JsonValue } | { readonly none: true };

/** How a remote dialog ended on the hand. `unavailable`: the loop serves no dialogs; the hand asks its own UI instead. */
export type DialogOutcome =
	| { readonly kind: "answered"; readonly value: unknown }
	| { readonly kind: "default" }
	| { readonly kind: "unavailable"; readonly reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const isDialogMethod = (value: unknown): value is DialogMethod =>
	typeof value === "string" && (DIALOG_METHODS as readonly string[]).includes(value);

export function decodeDialogRequest(body: JsonValue): DialogRequest {
	if (!isRecord(body) || !isDialogMethod(body.method) || !Array.isArray(body.args))
		throw new Error("malformed ui dialog");
	const { timeoutMs } = body;
	if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0))
		throw new Error("malformed ui dialog timeout");
	return {
		method: body.method,
		args: body.args as JsonValue[],
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	};
}

export function decodeDialogAnswer(body: JsonValue): DialogAnswer {
	if (isRecord(body) && body.none === true && Object.keys(body).length === 1) return { none: true };
	if (isRecord(body) && "value" in body && Object.keys(body).length === 1) return { value: body.value as JsonValue };
	throw new Error("malformed ui dialog answer");
}

/**
 * Serves remote dialogs on the brain: `ask` raises the dialog on the loop's UI and resolves with its answer (`undefined`
 * when it settled with nothing). `signal` aborts when the hand stops waiting (its timeout, its abort) or the call ends;
 * `ask` must then settle the dialog so a later answer to it is refused.
 */
export function serveDialogPlane(
	ask: (request: DialogRequest, signal: AbortSignal) => Promise<JsonValue | undefined>,
): PlaneHandler {
	return async (body, signal) => {
		const value = await ask(decodeDialogRequest(body), signal);
		const answer: DialogAnswer = value === undefined ? { none: true } : { value };
		return answer as unknown as JsonValue;
	};
}

/**
 * Asks the loop that owns the running call (the hand's side). Timeout and abort are the hand's: either ends the wait
 * with `default`, and the request's abort reaches the loop, which settles its dialog. A loop that serves no dialogs (a
 * refusal of the request) is `unavailable`: the caller then asks its own UI, as before remote dialogs.
 */
export async function askRemoteDialog(
	nested: NestedRequest,
	request: DialogRequest,
	signal?: AbortSignal,
): Promise<DialogOutcome> {
	if (signal?.aborted) return { kind: "default" };
	const controller = new AbortController();
	const stop = (): void => controller.abort();
	signal?.addEventListener("abort", stop, { once: true });
	const timer = request.timeoutMs === undefined ? undefined : setTimeout(stop, request.timeoutMs);
	try {
		const body = await nested(UI_DIALOG_PLANE, request as unknown as JsonValue, controller.signal);
		const answer = decodeDialogAnswer(body);
		return "none" in answer ? { kind: "answered", value: undefined } : { kind: "answered", value: answer.value };
	} catch (error) {
		if (controller.signal.aborted) return { kind: "default" };
		if (error instanceof PlaneRefusedError && error.reason === "plane_unavailable")
			return { kind: "unavailable", reason: error.reason };
		if (error instanceof PlaneRefusedError && error.reason === "parent_terminal") return { kind: "default" };
		throw error;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
	}
}
