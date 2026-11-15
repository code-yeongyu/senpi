import { toStoreValue, type WakeEvent } from "@earendil-works/pi-agent-core";
import type { StoreValue } from "@earendil-works/pi-agent-core/conformance";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { LoopWakeRoute } from "../extensions/runner.ts";
import type { CustomMessage } from "../messages.ts";

/** What a hand's late work did, as the loop's session does it: a custom message, a user message, or a UI notice. */
export type HandWakeSource = "message" | "user_message" | "notice";

/** One late effect of a hand's work, for the hand's wake outbox; its scope is the runtime's own. */
export interface HandWake {
	readonly source: HandWakeSource;
	readonly payload: StoreValue;
}

type SendMessage = LoopWakeRoute["sendMessage"];
type SendUserMessage = LoopWakeRoute["sendUserMessage"];
type Notify = LoopWakeRoute["notify"];

/**
 * The loop-side effects of a hand runtime's late work (brain/hand split H3), each turned into a wake for the brain that
 * owns the scope: exactly the arguments a local session's `sendMessage`, `sendUserMessage` and `ui.notify` would have
 * received, plus the loop session's id when a loop-hook call on that session started the work.
 */
export function loopWakeRoute(offer: (wake: HandWake) => void, sessionId?: string): LoopWakeRoute {
	const wake = (source: HandWakeSource, fields: Record<string, unknown>): void =>
		offer({ source, payload: toStoreValue(sessionId === undefined ? fields : { ...fields, sessionId }) });
	return {
		sendMessage: (message, options) => wake("message", { message, options }),
		sendUserMessage: (content, options) => wake("user_message", { content, options }),
		notify: (message, type) => wake("notice", { message, type }),
	};
}

/**
 * Where a loop-hook call's messages and notices go once the call ended: its runtime's wake outbox, or, on a runtime
 * without one, nowhere, and `dropped` reports each one so it is never lost silently.
 */
export function lateLoopRoute(
	wake: ((wake: HandWake) => void) | undefined,
	dropped: (error: string) => void,
): (sessionId: string) => Pick<LoopWakeRoute, "sendMessage" | "notify"> {
	if (wake !== undefined) return (sessionId) => loopWakeRoute(wake, sessionId);
	return (sessionId) => {
		const drop = (what: string) =>
			dropped(
				`A ${what} from loop session ${sessionId}'s hook work arrived after its call ended and was dropped: this runtime has no wake route to the loop.`,
			);
		return { sendMessage: () => drop("message"), notify: () => drop("notice") };
	};
}

/** A wake parsed on the brain, ready for the session that owns its scope (or the loop session it names). */
export type HandWakeDelivery = { readonly sessionId?: string } & (
	| {
			readonly kind: "message";
			readonly message: Parameters<SendMessage>[0];
			readonly options?: Parameters<SendMessage>[1];
	  }
	| {
			readonly kind: "user_message";
			readonly content: Parameters<SendUserMessage>[0];
			readonly options?: Parameters<SendUserMessage>[1];
	  }
	| { readonly kind: "notice"; readonly message: string; readonly type?: Parameters<Notify>[1] }
);

export class MalformedHandWakeError extends Error {
	override readonly name = "MalformedHandWakeError";
	readonly eventId: string;
	constructor(eventId: string, what: string) {
		super(`malformed hand wake ${eventId}: ${what}`);
		this.eventId = eventId;
	}
}

type StoreObject = { readonly [key: string]: StoreValue };
const isObject = (value: StoreValue | undefined): value is StoreObject =>
	value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);

const DELIVER_AS = ["steer", "followUp", "nextTurn"] as const;
const NOTICE_TYPES = ["info", "warning", "error"] as const;
const isOneOf = <T extends string>(value: StoreValue | undefined, allowed: readonly T[]): value is T =>
	typeof value === "string" && (allowed as readonly string[]).includes(value);

const isContentPart = (value: StoreValue): boolean =>
	isObject(value) &&
	((value.type === "text" && typeof value.text === "string") ||
		(value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"));

function content(value: StoreValue | undefined): string | (TextContent | ImageContent)[] | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every(isContentPart)) return value as unknown as (TextContent | ImageContent)[];
	return undefined;
}

function customMessage(value: StoreValue | undefined): Parameters<SendMessage>[0] | undefined {
	if (!isObject(value) || typeof value.customType !== "string" || typeof value.display !== "boolean") return undefined;
	const body = content(value.content);
	if (body === undefined) return undefined;
	const message: Pick<CustomMessage, "customType" | "content" | "display" | "details"> = {
		customType: value.customType,
		content: body,
		display: value.display,
		...(value.details === undefined ? {} : { details: value.details }),
	};
	return message;
}

function messageOptions(value: StoreValue | undefined): Parameters<SendMessage>[1] | null {
	if (value === undefined) return undefined;
	if (!isObject(value)) return null;
	const { triggerTurn, deliverAs } = value;
	if (triggerTurn !== undefined && typeof triggerTurn !== "boolean") return null;
	if (deliverAs !== undefined && !isOneOf(deliverAs, DELIVER_AS)) return null;
	return {
		...(triggerTurn === undefined ? {} : { triggerTurn }),
		...(deliverAs === undefined ? {} : { deliverAs }),
	};
}

function userMessageOptions(value: StoreValue | undefined): Parameters<SendUserMessage>[1] | null {
	if (value === undefined) return undefined;
	if (!isObject(value)) return null;
	const { deliverAs, expandPromptTemplates } = value;
	if (deliverAs !== undefined && deliverAs !== "steer" && deliverAs !== "followUp") return null;
	if (expandPromptTemplates !== undefined && typeof expandPromptTemplates !== "boolean") return null;
	return {
		...(deliverAs === undefined ? {} : { deliverAs }),
		...(expandPromptTemplates === undefined ? {} : { expandPromptTemplates }),
	};
}

/** On the brain: what a taken wake asks the loop to do, parsed once at this boundary. */
export function parseHandWake(wake: WakeEvent): HandWakeDelivery {
	const fail = (what: string): never => {
		throw new MalformedHandWakeError(wake.eventId, what);
	};
	const payload = isObject(wake.payload) ? wake.payload : fail("payload");
	const { sessionId } = payload;
	if (sessionId !== undefined && typeof sessionId !== "string") return fail("sessionId");
	const session = typeof sessionId === "string" ? { sessionId } : {};
	switch (wake.source) {
		case "message": {
			const message = customMessage(payload.message) ?? fail("message");
			const options = messageOptions(payload.options);
			if (options === null) return fail("message options");
			return { ...session, kind: "message", message, ...(options === undefined ? {} : { options }) };
		}
		case "user_message": {
			const body = content(payload.content) ?? fail("user message content");
			const options = userMessageOptions(payload.options);
			if (options === null) return fail("user message options");
			return { ...session, kind: "user_message", content: body, ...(options === undefined ? {} : { options }) };
		}
		case "notice": {
			const message = typeof payload.message === "string" ? payload.message : fail("notice");
			const { type } = payload;
			if (type !== undefined && !isOneOf(type, NOTICE_TYPES)) return fail("notice type");
			return { ...session, kind: "notice", message, ...(isOneOf(type, NOTICE_TYPES) ? { type } : {}) };
		}
		default:
			return fail(`source ${wake.source}`);
	}
}

/** On the brain: a taken wake becomes the very call a local session makes; `session` is the session it belongs to. */
export function deliverHandWake(wake: WakeEvent, session: LoopWakeRoute): void {
	const delivery = parseHandWake(wake);
	switch (delivery.kind) {
		case "message":
			return session.sendMessage(delivery.message, delivery.options);
		case "user_message":
			return session.sendUserMessage(delivery.content, delivery.options);
		case "notice":
			return session.notify(delivery.message, delivery.type);
	}
}
