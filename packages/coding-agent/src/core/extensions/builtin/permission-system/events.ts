import type { ExtensionAPI } from "../../types.ts";
import type { PermissionDecision, Request } from "./types.ts";

/**
 * Event type for when a permission is asked.
 * Contains the full request information.
 */
export type PermissionAskedEvent = Request;

/**
 * Event type for when a permission is replied to.
 * Contains the reply and identifiers to correlate with the request.
 */
export type PermissionRepliedEvent = {
	requestID: string;
	sessionID: string;
	reply: PermissionDecision;
};

/** A rule whose identity form is unavailable (resolver timeout or open breaker), design 6.8. */
export type PermissionRuleIdentityUnavailableEvent = {
	permission: string;
	pattern: string;
	code: string;
};

/** A resolver breaker transition or leak-cap change for one volume key, design 6.8. */
export type PermissionResolverStateEvent = {
	volumeKey: string;
	state: string;
	leaked: number;
};

/**
 * Event emitter interface for permission events.
 * Injectable into services for loose coupling.
 */
export interface PermissionEventEmitter {
	/**
	 * Emit a permission_asked event.
	 * @param request - The permission request being asked
	 */
	emitAsked(request: Request): void;

	/**
	 * Emit a permission_replied event.
	 * @param requestID - The ID of the request being replied to
	 * @param sessionID - The session ID associated with the request
	 * @param reply - The user's reply (once, always, or reject)
	 */
	emitReplied(requestID: string, sessionID: string, reply: PermissionDecision): void;

	/** Emit a permission_rule_identity_unavailable event. */
	emitRuleIdentityUnavailable(event: PermissionRuleIdentityUnavailableEvent): void;

	/** Emit a permission_resolver_state event. */
	emitResolverState(event: PermissionResolverStateEvent): void;
}

/**
 * Creates an event emitter that wraps pi.events for inter-extension communication.
 * Use this when running within the pi extension system.
 *
 * @param pi - The ExtensionAPI provided by the pi extension system
 * @returns PermissionEventEmitter that emits via pi.events
 */
export function createEventEmitter(pi: ExtensionAPI): PermissionEventEmitter {
	return {
		emitAsked: (request: Request) => {
			pi.events.emit("permission_asked", request);
		},
		emitReplied: (requestID: string, sessionID: string, reply: PermissionDecision) => {
			pi.events.emit("permission_replied", { requestID, sessionID, reply });
		},
		emitRuleIdentityUnavailable: (event) => {
			pi.events.emit("permission_rule_identity_unavailable", event);
		},
		emitResolverState: (event) => {
			pi.events.emit("permission_resolver_state", event);
		},
	};
}

/**
 * Local event emitter implementation for standalone or test usage.
 * Uses a simple callback registry when pi.events is not available.
 *
 * @returns PermissionEventEmitter with local event handling
 */
export function createLocalEventEmitter(): PermissionEventEmitter & {
	/**
	 * Register a handler for permission_asked events.
	 * @param handler - Callback invoked when a permission is asked
	 * @returns Unsubscribe function
	 */
	onAsked(handler: (request: Request) => void): () => void;

	/**
	 * Register a handler for permission_replied events.
	 * @param handler - Callback invoked when a permission is replied to
	 * @returns Unsubscribe function
	 */
	onReplied(handler: (event: PermissionRepliedEvent) => void): () => void;

	onRuleIdentityUnavailable(handler: (event: PermissionRuleIdentityUnavailableEvent) => void): () => void;

	onResolverState(handler: (event: PermissionResolverStateEvent) => void): () => void;

	/**
	 * Clear all registered handlers.
	 */
	clear(): void;
} {
	const askedHandlers = new Set<(request: Request) => void>();
	const repliedHandlers = new Set<(event: PermissionRepliedEvent) => void>();
	const identityHandlers = new Set<(event: PermissionRuleIdentityUnavailableEvent) => void>();
	const resolverHandlers = new Set<(event: PermissionResolverStateEvent) => void>();

	return {
		emitAsked: (request: Request) => {
			for (const handler of askedHandlers) {
				try {
					handler(request);
				} catch (err) {
					console.error("Error in permission_asked handler:", err);
				}
			}
		},

		emitReplied: (requestID: string, sessionID: string, reply: PermissionDecision) => {
			const event: PermissionRepliedEvent = { requestID, sessionID, reply };
			for (const handler of repliedHandlers) {
				try {
					handler(event);
				} catch (err) {
					console.error("Error in permission_replied handler:", err);
				}
			}
		},

		onAsked: (handler: (request: Request) => void): (() => void) => {
			askedHandlers.add(handler);
			return () => askedHandlers.delete(handler);
		},

		onReplied: (handler: (event: PermissionRepliedEvent) => void): (() => void) => {
			repliedHandlers.add(handler);
			return () => repliedHandlers.delete(handler);
		},

		emitRuleIdentityUnavailable: (event) => {
			for (const handler of identityHandlers) handler(event);
		},

		emitResolverState: (event) => {
			for (const handler of resolverHandlers) handler(event);
		},

		onRuleIdentityUnavailable: (handler) => {
			identityHandlers.add(handler);
			return () => identityHandlers.delete(handler);
		},

		onResolverState: (handler) => {
			resolverHandlers.add(handler);
			return () => resolverHandlers.delete(handler);
		},

		clear: () => {
			askedHandlers.clear();
			repliedHandlers.clear();
			identityHandlers.clear();
			resolverHandlers.clear();
		},
	};
}
