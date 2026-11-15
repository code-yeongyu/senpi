import { WAKE_DROPPED_SOURCE, type WakeEvent, type WakeRefusal } from "@earendil-works/pi-agent-core";
import type { StoreValue } from "@earendil-works/pi-agent-core/conformance";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { NON_INTERACTIVE_MODES } from "../extensions/builtin/terminal/notify.ts";
import type { LoopWakeRoute } from "../extensions/runner.ts";
import type { CustomMessage } from "../messages.ts";

type SendMessage = LoopWakeRoute["sendMessage"];
type SendUserMessage = LoopWakeRoute["sendUserMessage"];
type Notify = LoopWakeRoute["notify"];

/** A wake parsed on the brain, for the loop session of its scope that it names (`sessionId`), or the scope's own. */
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
	| { readonly kind: "entry"; readonly customType: string; readonly data?: unknown }
	| { readonly kind: "notice"; readonly message: string; readonly type?: Parameters<Notify>[1] }
	| { readonly kind: "dropped"; readonly reason: string; readonly count: number }
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
	return { ...(triggerTurn === undefined ? {} : { triggerTurn }), ...(deliverAs === undefined ? {} : { deliverAs }) };
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
		case "entry": {
			const customType = typeof payload.customType === "string" ? payload.customType : fail("entry customType");
			return {
				...session,
				kind: "entry",
				customType,
				...(payload.data === undefined ? {} : { data: payload.data }),
			};
		}
		case "notice": {
			const message = typeof payload.message === "string" ? payload.message : fail("notice");
			const { type } = payload;
			if (type !== undefined && !isOneOf(type, NOTICE_TYPES)) return fail("notice type");
			return { ...session, kind: "notice", message, ...(isOneOf(type, NOTICE_TYPES) ? { type } : {}) };
		}
		case WAKE_DROPPED_SOURCE: {
			const { reason, count } = payload;
			if (typeof reason !== "string" || typeof count !== "number") return fail("drop report");
			return { kind: "dropped", reason, count };
		}
		default:
			return fail(`source ${wake.source}`);
	}
}

/** The brain session a wake is delivered to: its writes, and the facts its delivery guard reads. */
export interface HandWakeSession extends LoopWakeRoute {
	/** The session's mode and model now, as a local notifier reads them from its context; none before it started. */
	readonly context: () => { readonly mode: string; readonly model: unknown } | undefined;
}

/** `skipped`: the session is one-shot (print/json), has no model, or has not started, so the wake may not start a turn. */
export type HandWakeOutcome = "delivered" | "skipped";

/**
 * Whether the session may start a turn now (senpi#6767 review M2): the guard every local notifier applies before it
 * wakes a session (`terminal/notify.ts`, codemode's `EvalNotifier`), applied here because on a hand they send without
 * it. A one-shot run (print/json) is never woken (it would never end), and neither is a session with no model (an
 * auth-less turn would spin).
 */
function mayStartTurn(session: HandWakeSession): boolean {
	const context = session.context();
	return context !== undefined && !NON_INTERACTIVE_MODES.has(context.mode) && context.model !== undefined;
}

/**
 * On the brain: a taken wake becomes the very call a local session makes. A wake that would start a turn (a message
 * with `triggerTurn`, or a user message) is skipped when the session may not start one; entries, notices and messages
 * for the next turn are always delivered. A drop report becomes a warning notice.
 */
export function deliverHandWake(wake: WakeEvent, session: HandWakeSession): HandWakeOutcome {
	const delivery = parseHandWake(wake);
	switch (delivery.kind) {
		case "message":
			if (delivery.options?.triggerTurn === true && !mayStartTurn(session)) return "skipped";
			session.sendMessage(delivery.message, delivery.options);
			return "delivered";
		case "user_message":
			if (!mayStartTurn(session)) return "skipped";
			session.sendUserMessage(delivery.content, delivery.options);
			return "delivered";
		case "entry":
			session.appendEntry(delivery.customType, delivery.data);
			return "delivered";
		case "notice":
			session.notify(delivery.message, delivery.type);
			return "delivered";
		case "dropped":
			session.notify(
				`${delivery.count} late result${delivery.count === 1 ? "" : "s"} from work on the user's machine never arrived (${delivery.reason}).`,
				"warning",
			);
			return "delivered";
	}
}

/**
 * The brain's check that a wake names only a loop session of its own scope (senpi#6767 review L3), for
 * `serveHandWakes({ check })`. `sessionsOf` answers the loop sessions bound to a scope; a wake naming any other, or a
 * malformed session id, is refused `not_scope_session` and never committed.
 */
export function scopeSessionCheck(
	sessionsOf: (scope: string) => ReadonlySet<string> | undefined,
): (wake: WakeEvent) => WakeRefusal | undefined {
	return (wake) => {
		const sessionId = isObject(wake.payload) ? wake.payload.sessionId : undefined;
		if (sessionId === undefined) return undefined;
		return typeof sessionId === "string" && sessionsOf(wake.scope)?.has(sessionId) === true
			? undefined
			: "not_scope_session";
	};
}
