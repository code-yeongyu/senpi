/**
 * `subscribe_sessions` request parsing and the per-subscription match rule.
 *
 * Parsed once at the wire boundary, so the stream downstream only ever holds a selector that is known to
 * be well formed. Every refusal names the field that was wrong and what to send instead.
 */
import type { RpcCommand } from "./rpc-types.ts";
import type { SessionStatusEntryView } from "./session-status.ts";

export type SessionSelector =
	| { readonly kind: "all" }
	| { readonly kind: "ids"; readonly ids: ReadonlySet<string> }
	| { readonly kind: "childrenOf"; readonly parent: string };

export type MirrorSelection =
	| { readonly kind: "none" }
	| { readonly kind: "all" }
	| { readonly kind: "types"; readonly types: ReadonlySet<string> };

export interface SubscriptionOptions {
	readonly selector: SessionSelector;
	readonly includeWorkers: boolean;
	readonly includeContext: boolean;
	readonly mirror: MirrorSelection;
	readonly effects: boolean;
}

export interface SubscriptionRefusal {
	readonly reason: string;
	readonly action: string;
}

const MAX_SELECTOR_IDS = 1_024;
const MAX_MIRROR_TYPES = 64;
const RECORD_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function refusal(reason: string, action: string): { readonly refusal: SubscriptionRefusal } {
	return { refusal: { reason, action } };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSelector(
	value: unknown,
): { readonly selector: SessionSelector } | { readonly refusal: SubscriptionRefusal } {
	if (value === undefined || value === "all") return { selector: { kind: "all" } };
	const action =
		'send sessions: "all", { ids: [<sessionId | durableSessionId | sessionPath>] } or { childrenOf: <durableSessionId> }';
	if (!isRecord(value)) return refusal('sessions must be "all" or an object', action);
	if ("ids" in value && !("childrenOf" in value)) {
		const ids = value.ids;
		if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_SELECTOR_IDS)
			return refusal(`sessions.ids must be a non-empty array of at most ${MAX_SELECTOR_IDS} strings`, action);
		if (!ids.every((id): id is string => typeof id === "string" && id.length > 0))
			return refusal("every sessions.ids entry must be a non-empty string", action);
		return { selector: { kind: "ids", ids: new Set(ids) } };
	}
	if ("childrenOf" in value && !("ids" in value)) {
		const parent = value.childrenOf;
		if (typeof parent !== "string" || parent.length === 0)
			return refusal("sessions.childrenOf must be a non-empty durable session id", action);
		return { selector: { kind: "childrenOf", parent } };
	}
	return refusal("sessions must name exactly one of ids or childrenOf", action);
}

function parseMirror(value: unknown): { readonly mirror: MirrorSelection } | { readonly refusal: SubscriptionRefusal } {
	if (value === undefined || value === "none") return { mirror: { kind: "none" } };
	if (value === "all") return { mirror: { kind: "all" } };
	const action = 'send mirror: "none", "all" or an array of record types such as ["message_update"]';
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MIRROR_TYPES)
		return refusal(
			`mirror must be "none", "all" or a non-empty array of at most ${MAX_MIRROR_TYPES} record types`,
			action,
		);
	if (!value.every((type): type is string => typeof type === "string" && RECORD_TYPE_PATTERN.test(type)))
		return refusal(`every mirror entry must be a record type matching ${RECORD_TYPE_PATTERN.source}`, action);
	return { mirror: { kind: "types", types: new Set(value) } };
}

function optionalBoolean(value: unknown, field: string): boolean | undefined | SubscriptionRefusal {
	if (value === undefined || typeof value === "boolean") return value;
	return { reason: `${field} must be a boolean`, action: `send ${field}: true or false, or omit it` };
}

export function parseSubscription(
	request: Readonly<
		Pick<
			Extract<RpcCommand, { type: "subscribe_sessions" }>,
			"sessions" | "mirror" | "include_workers" | "include_context" | "effects"
		>
	>,
): { readonly options: SubscriptionOptions } | { readonly refusal: SubscriptionRefusal } {
	const selector = parseSelector(request.sessions);
	if ("refusal" in selector) return selector;
	const mirror = parseMirror(request.mirror);
	if ("refusal" in mirror) return mirror;
	const includeWorkers = optionalBoolean(request.include_workers, "include_workers");
	if (typeof includeWorkers === "object") return { refusal: includeWorkers };
	const includeContext = optionalBoolean(request.include_context, "include_context");
	if (typeof includeContext === "object") return { refusal: includeContext };
	const effects = optionalBoolean(request.effects, "effects");
	if (typeof effects === "object") return { refusal: effects };
	return {
		options: {
			selector: selector.selector,
			// A childrenOf subscription exists to watch machine-driven children, which open as workers.
			includeWorkers: includeWorkers ?? selector.selector.kind === "childrenOf",
			includeContext: includeContext ?? false,
			mirror: mirror.mirror,
			// A childrenOf subscription watches machine-driven work, whose truth is the receipts.
			effects: effects ?? selector.selector.kind === "childrenOf",
		},
	};
}

export function subscriptionMatches(
	options: SubscriptionOptions,
	sessionId: string,
	entry: Pick<SessionStatusEntryView, "kind" | "durableSessionId" | "sessionPath" | "context" | "openContext">,
): boolean {
	if (entry.kind === "worker" && !options.includeWorkers) return false;
	const selector = options.selector;
	switch (selector.kind) {
		case "all":
			return true;
		case "ids":
			return (
				selector.ids.has(sessionId) ||
				(entry.durableSessionId !== undefined && selector.ids.has(entry.durableSessionId)) ||
				(entry.sessionPath !== undefined && selector.ids.has(entry.sessionPath))
			);
		case "childrenOf": {
			// Lineage matching reads the frozen open-time context: a set_session_context patch
			// can neither move a session into a supervisor's children view nor out of it.
			const lineage = entry.openContext ?? entry.context;
			const parent = lineage.parent_session_id ?? lineage.root_session_id;
			return parent === selector.parent;
		}
		default: {
			const exhaustive: never = selector;
			throw new Error(`unexpected selector ${String(exhaustive)}`);
		}
	}
}

export function mirrorsRecord(mirror: MirrorSelection, recordType: string): boolean {
	switch (mirror.kind) {
		case "none":
			return false;
		case "all":
			return true;
		case "types":
			return mirror.types.has(recordType);
		default: {
			const exhaustive: never = mirror;
			throw new Error(`unexpected mirror ${String(exhaustive)}`);
		}
	}
}
