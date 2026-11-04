import { randomUUID } from "node:crypto";
import type { McpFormBinding, McpFormScope } from "../../core/mcp-form-types.ts";
import type { McpFormDialog } from "./mcp-form-dialog.ts";
import type { Binding, Connection, McpPresenterConnection, McpPresenterState } from "./mcp-presenter-bindings.ts";

export interface McpPresenterRegistration {
	readonly id: string;
}
export interface Registration extends McpPresenterRegistration {
	readonly principal: string;
	readonly generation: string;
	readonly binding: Binding;
	readonly connection: Connection;
	readonly kind: McpFormScope["presenterKind"];
	active: boolean;
}
export interface Grant {
	readonly id: string;
	readonly registration: Registration;
	readonly scope: McpFormScope;
	readonly lifetime: AbortController;
	readonly dialogs: Map<string, McpFormDialog>;
}

export function enroll(state: McpPresenterState, principal: string = randomUUID()) {
	const generation = randomUUID();
	return {
		register: (
			handle: McpFormBinding,
			sender: McpPresenterConnection,
			options: { readonly kind: McpFormScope["presenterKind"] },
		): McpPresenterRegistration => {
			const binding = [...state.bindings.values()].find((value) => value === handle);
			const connection = state.connections.get(sender);
			if (!binding || binding.grant || !connection?.attachments.has(binding))
				throw new Error("presenter_not_authorized");
			const registration: Registration = {
				id: randomUUID(),
				principal,
				generation,
				binding,
				connection,
				kind: options.kind,
				active: true,
			};
			state.registrations.set(registration, registration);
			return registration;
		},
		acquire: (handle: McpPresenterRegistration): { readonly grantId: string; readonly scope: McpFormScope } => {
			const registration = state.registrations.get(handle);
			if (!registration || registration.principal !== principal || !registration.active)
				throw new Error("presenter_not_authorized");
			const { binding, connection } = registration;
			const attachment = connection.attachments.get(binding);
			if (!attachment || binding.lifetime.signal.aborted || binding.grant)
				throw new Error("presenter_not_authorized");
			const scope: McpFormScope = {
				hostInstance: state.instance,
				durableSessionId: binding.durableId,
				bindingEpoch: binding.epoch,
				attachmentId: attachment.id,
				attachmentEpoch: attachment.epoch,
				connectionId: connection.id,
				connectionEpoch: connection.epoch,
				presenterPrincipalId: principal,
				presenterGeneration: generation,
				presentationBindingId: registration.id,
				presenterKind: registration.kind,
				purpose: "mcp_form",
			};
			const grant: Grant = {
				id: randomUUID(),
				registration,
				scope,
				lifetime: new AbortController(),
				dialogs: new Map(),
			};
			binding.grant = grant;
			for (const listener of binding.listeners) listener();
			return { grantId: grant.id, scope };
		},
		revoke: (handle: McpPresenterRegistration): void => {
			const registration = state.registrations.get(handle);
			if (registration?.principal === principal) revoke(state, registration);
		},
	};
}

export function current(state: McpPresenterState, grant: Grant): boolean {
	const { registration, scope } = grant;
	const { binding, connection } = registration;
	return (
		registration.active &&
		!binding.lifetime.signal.aborted &&
		!grant.lifetime.signal.aborted &&
		state.bindings.get(binding.sessionId) === binding &&
		binding.grant === grant &&
		state.connections.get(connection) === connection &&
		connection.attachments.get(binding)?.epoch === scope.attachmentEpoch
	);
}

export function revoke(state: McpPresenterState, registration: Registration, operation = false): void {
	registration.active = false;
	state.registrations.delete(registration);
	const binding = registration.binding;
	const grant = binding.grant;
	if (!grant || grant.registration !== registration) return;
	binding.grant = undefined;
	for (const listener of binding.listeners) listener();
	// Retain entry references after authority is fenced. Cleanup never validates the revoked sender.
	for (const dialog of [...grant.dialogs.values()])
		dialog.terminate(operation ? "operation_aborted" : "presentation_lost");
	grant.lifetime.abort();
}
