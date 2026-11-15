import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { StoreValue } from "../durable/store.ts";
import type { WakeDrop } from "./wake-link.ts";
import { WAKE_DROPPED_SOURCE, type WakeEvent, type WakeRefusal } from "./wake-types.ts";

/**
 * The brain side of a hand's wakes (senpi H3): what a taken wake asks the loop to do, parsed once at this boundary,
 * and its delivery to the loop session as a local session would make it. `wake.scope` is the hand's execution scope
 * id: the id the brain gave the session's `ExecutionScope`. A senpi session mints a fresh random id per session
 * (`pipeline-witness.ts`), so it is not the session id unless the brain chose it to be; map a scope to its sessions.
 */

/** Session modes that never start a turn by themselves (a one-shot run would never end). */
export const ONE_SHOT_MODES: ReadonlySet<string> = new Set(["print", "json"]);

type Content = string | (TextContent | ImageContent)[];

export interface HandWakeMessage {
	readonly customType: string;
	readonly content: Content;
	readonly display: boolean;
	readonly details?: unknown;
}

export interface HandWakeMessageOptions {
	readonly triggerTurn?: boolean;
	readonly deliverAs?: "steer" | "followUp" | "nextTurn";
}

export interface HandWakeUserMessageOptions {
	readonly deliverAs?: "steer" | "followUp";
	readonly expandPromptTemplates?: boolean;
}

export type HandWakeNoticeType = "info" | "warning" | "error";

/** A wake parsed on the brain, for the loop session of its scope it names (`sessionId`), or the scope's own. */
export type HandWakeDelivery = { readonly sessionId?: string } & (
	| { readonly kind: "message"; readonly message: HandWakeMessage; readonly options?: HandWakeMessageOptions }
	| { readonly kind: "user_message"; readonly content: Content; readonly options?: HandWakeUserMessageOptions }
	| { readonly kind: "entry"; readonly customType: string; readonly data?: unknown }
	| { readonly kind: "notice"; readonly message: string; readonly type?: HandWakeNoticeType }
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
const isOneOf = <T extends string>(value: StoreValue | undefined, allowed: readonly T[]): value is T =>
	typeof value === "string" && (allowed as readonly string[]).includes(value);

const DELIVER_AS = ["steer", "followUp", "nextTurn"] as const;
const USER_DELIVER_AS = ["steer", "followUp"] as const;
const NOTICE_TYPES = ["info", "warning", "error"] as const;

const isContentPart = (value: StoreValue): boolean =>
	isObject(value) &&
	((value.type === "text" && typeof value.text === "string") ||
		(value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"));

function content(value: StoreValue | undefined): Content | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every(isContentPart)) return value as unknown as (TextContent | ImageContent)[];
	return undefined;
}

function message(value: StoreValue | undefined): HandWakeMessage | undefined {
	if (!isObject(value) || typeof value.customType !== "string" || typeof value.display !== "boolean") return undefined;
	const body = content(value.content);
	if (body === undefined) return undefined;
	return {
		customType: value.customType,
		content: body,
		display: value.display,
		...(value.details === undefined ? {} : { details: value.details }),
	};
}

/** A payload's `options`: absent, the fields it has, or `null` when malformed. */
function optionsOf<T>(value: StoreValue | undefined, fields: { readonly [K in keyof T]: (v: StoreValue) => boolean }) {
	if (value === undefined) return undefined;
	if (!isObject(value)) return null;
	const out: Record<string, StoreValue> = {};
	for (const [name, valid] of Object.entries(fields) as [string, (v: StoreValue) => boolean][]) {
		const field = value[name];
		if (field === undefined) continue;
		if (!valid(field)) return null;
		out[name] = field;
	}
	return out as T;
}

/** What a taken wake asks the loop to do; anything else throws {@link MalformedHandWakeError}. */
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
			const options = optionsOf<HandWakeMessageOptions>(payload.options, {
				triggerTurn: (v) => typeof v === "boolean",
				deliverAs: (v) => isOneOf(v, DELIVER_AS),
			});
			if (options === null) return fail("message options");
			const body = message(payload.message) ?? fail("message");
			return { ...session, kind: "message", message: body, ...(options === undefined ? {} : { options }) };
		}
		case "user_message": {
			const options = optionsOf<HandWakeUserMessageOptions>(payload.options, {
				deliverAs: (v) => isOneOf(v, USER_DELIVER_AS),
				expandPromptTemplates: (v) => typeof v === "boolean",
			});
			if (options === null) return fail("user message options");
			const body = content(payload.content) ?? fail("user message content");
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
			const notice = typeof payload.message === "string" ? payload.message : fail("notice");
			const { type } = payload;
			if (type !== undefined && !isOneOf(type, NOTICE_TYPES)) return fail("notice type");
			return { ...session, kind: "notice", message: notice, ...(isOneOf(type, NOTICE_TYPES) ? { type } : {}) };
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

/** The brain session a wake is delivered to: the calls a local session makes, and the facts its guard reads. */
export interface HandWakeSession {
	sendMessage(message: HandWakeMessage, options?: HandWakeMessageOptions): void;
	sendUserMessage(content: Content, options?: HandWakeUserMessageOptions): void;
	appendEntry(customType: string, data?: unknown): void;
	notify(message: string, type?: HandWakeNoticeType): void;
	/** The session's mode and model now, as a local notifier reads them; `undefined` before the session started. */
	context(): { readonly mode: string; readonly model: unknown } | undefined;
}

/** `skipped`: the session is one-shot (print/json), has no model, or has not started, so the wake may not start a turn. */
export type HandWakeOutcome = "delivered" | "skipped";

/**
 * Whether the session may start a turn now (senpi#6767 review M2): the guard every local notifier applies before it
 * wakes a session (senpi's terminal and eval notifiers), applied here because on a hand they send without it.
 */
function mayStartTurn(session: HandWakeSession): boolean {
	const context = session.context();
	return context !== undefined && !ONE_SHOT_MODES.has(context.mode) && context.model !== undefined;
}

const dropNotice = (count: number, reason: string): string =>
	`${count} late result${count === 1 ? "" : "s"} from work on the user's machine never arrived (${reason}).`;

/**
 * A taken wake becomes the very call a local session makes. A wake that would start a turn (a message with
 * `triggerTurn`, or a user message) is skipped when the session may not start one; entries, notices and messages for
 * the next turn are always delivered. A drop report becomes a warning notice the user sees, as a local session reports
 * lost background output.
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
			session.notify(dropNotice(delivery.count, delivery.reason), "warning");
			return "delivered";
	}
}

/**
 * The consumer of `serveHandWakes({ onDropped })` (a best-effort `unrecorded` report, which has no durable record):
 * the same warning notice a durable drop report gives, shown in each session of `drop.scope`.
 */
export function deliverHandDrop(drop: WakeDrop, session: Pick<HandWakeSession, "notify">): void {
	session.notify(dropNotice(drop.count, drop.reason), "warning");
}

/**
 * The brain's check that a wake names only a loop session of its own scope (senpi#6767 review L3), for
 * `serveHandWakes({ check })`. `sessionsOf` answers the loop sessions bound to a scope, or `undefined` while none are
 * known (refused `unknown_scope`, which the hand retries). A wake naming any other session, or a malformed session id,
 * is refused `not_scope_session` for good, never committed, and reported dropped (`refused`) after the retention.
 */
export function scopeSessionCheck(
	sessionsOf: (scope: string) => ReadonlySet<string> | undefined,
): (wake: WakeEvent) => WakeRefusal | undefined {
	return (wake) => {
		const sessionId = isObject(wake.payload) ? wake.payload.sessionId : undefined;
		if (sessionId === undefined) return undefined;
		const sessions = sessionsOf(wake.scope);
		// Sessions not known yet (a brain restart, a bind still in progress) is not an answer: the hand retries.
		if (sessions === undefined) return "unknown_scope";
		return typeof sessionId === "string" && sessions.has(sessionId) ? undefined : "not_scope_session";
	};
}
