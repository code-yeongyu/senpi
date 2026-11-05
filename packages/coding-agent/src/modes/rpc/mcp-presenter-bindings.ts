import { randomUUID } from "node:crypto";
import type { McpFormBinding } from "../../core/mcp-form-types.ts";
import type { McpFormClock, McpPresenterFrame } from "./mcp-form-dialog.ts";
import { presentation } from "./mcp-presenter-forms.ts";
import {
	holders,
	revoke,
	type Grant,
	type McpPresenterRegistration,
	type Registration,
} from "./mcp-presenter-grants.ts";

export type Sender = (frame: McpPresenterFrame) => boolean;
export interface McpPresenterConnection {
	readonly id: string;
	readonly epoch: string;
	readonly nonce: string;
}
export interface Connection extends McpPresenterConnection {
	readonly send: Sender;
	readonly attachments: Map<Binding, { readonly id: string; readonly epoch: string }>;
}
export interface Binding extends McpFormBinding {
	readonly sessionId: string;
	readonly durableId: string;
	readonly lifetime: AbortController;
	readonly admit: () => void;
	readonly listeners: Set<() => void>;
	/** Every holder of this binding; each grant passes `current()` on its own. */
	readonly grants: Set<Grant>;
	/** The binding's one form FIFO, whichever holder answers (D11 S3-3b T10). */
	readonly queue: object;
	/** Open from the first holder until the last one leaves: the readiness version and presentation lifetime. */
	presence?: { readonly id: string; readonly lifetime: AbortController };
}
export interface McpPresenterConnectionContext {
	hostInstance: string;
	connectionNonce: string;
	bindingEpoch: string;
	attachmentId: string;
	attachmentEpoch: string;
}

/** The state one `McpPresenterAuthority` owns; the bindings, grants and forms modules all act on the same instance. */
export interface McpPresenterState {
	readonly instance: string;
	readonly clock: McpFormClock;
	readonly connections: Map<McpPresenterConnection, Connection>;
	readonly bindings: Map<string, Binding>;
	readonly registrations: Map<McpPresenterRegistration, Registration>;
}

export function dispose(state: McpPresenterState): void {
	for (const binding of [...state.bindings.values()]) binding.dispose();
	state.connections.clear();
	state.registrations.clear();
}

export function connect(state: McpPresenterState, id: string, send: Sender): McpPresenterConnection {
	const connection: Connection = { id, send, epoch: randomUUID(), nonce: randomUUID(), attachments: new Map() };
	state.connections.set(connection, connection);
	return connection;
}

export function attach(state: McpPresenterState, sender: McpPresenterConnection, handle: McpFormBinding): void {
	const connection = state.connections.get(sender);
	const binding = [...state.bindings.values()].find((value) => value === handle);
	if (connection && binding && !connection.attachments.has(binding))
		connection.attachments.set(binding, { id: randomUUID(), epoch: randomUUID() });
}

export function connectionContext(
	state: McpPresenterState,
	sender: McpPresenterConnection,
	sessionId: string,
): McpPresenterConnectionContext | undefined {
	const connection = state.connections.get(sender);
	const binding = state.bindings.get(sessionId);
	const attachment = binding && connection?.attachments.get(binding);
	if (!connection || !binding || !attachment) return undefined;
	return {
		hostInstance: state.instance,
		connectionNonce: connection.nonce,
		bindingEpoch: binding.epoch,
		attachmentId: attachment.id,
		attachmentEpoch: attachment.epoch,
	};
}

export function detach(state: McpPresenterState, sender: McpPresenterConnection, handle?: McpFormBinding): void {
	const connection = state.connections.get(sender);
	if (!connection) return;
	for (const binding of connection.attachments.keys()) {
		if (handle !== undefined && handle !== binding) continue;
		connection.attachments.delete(binding);
		revokeHeld(state, binding, connection);
	}
	if (handle === undefined) state.connections.delete(sender);
}

export function withdraw(state: McpPresenterState, sender: McpPresenterConnection): void {
	const connection = state.connections.get(sender);
	if (!connection) return;
	for (const binding of connection.attachments.keys()) revokeHeld(state, binding, connection);
}

function revokeHeld(state: McpPresenterState, binding: Binding, connection: Connection): void {
	for (const grant of [...binding.grants])
		if (grant.registration.connection === connection) revoke(state, grant.registration);
}

export function bind(
	state: McpPresenterState,
	sessionId: string,
	durableId: string,
	admit: () => void,
): McpFormBinding {
	state.bindings.get(sessionId)?.dispose();
	const lifetime = new AbortController();
	const binding: Binding = {
		sessionId,
		durableId,
		admit,
		epoch: randomUUID(),
		lifetime,
		signal: lifetime.signal,
		listeners: new Set(),
		grants: new Set(),
		queue: {},
		version: () => (holders(state, binding).length > 0 ? binding.presence?.id : undefined),
		subscribe: (listener) => {
			binding.listeners.add(listener);
			return () => {
				binding.listeners.delete(listener);
			};
		},
		capture: () => {
			const presence = binding.presence;
			return presence && holders(state, binding).length > 0 ? presentation(state, binding, presence) : undefined;
		},
		dispose: () => {
			binding.lifetime.abort();
			for (const grant of [...binding.grants]) revoke(state, grant.registration, true);
			if (state.bindings.get(sessionId) === binding) state.bindings.delete(sessionId);
			for (const connection of state.connections.values()) connection.attachments.delete(binding);
			binding.listeners.clear();
		},
	};
	state.bindings.set(sessionId, binding);
	return binding;
}
