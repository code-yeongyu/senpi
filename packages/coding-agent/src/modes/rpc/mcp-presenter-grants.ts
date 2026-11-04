import { randomUUID } from "node:crypto";
import type { McpFormBinding, McpFormScope, McpFormSettled, McpPresenterIdentity } from "../../core/mcp-form-types.ts";
import type { McpFormDialog } from "./mcp-form-dialog.ts";
import type { Binding, Connection, McpPresenterConnection, McpPresenterState } from "./mcp-presenter-bindings.ts";

/** The one acquire feature this host negotiates: `mcp_form_resolved.elsewhere` and `mcp_form_settled`. */
const ELSEWHERE_FEATURE = "elsewhere_v1";

/** A signed acquire's feature list: at most 16 short strings. Unknown names are ignored, never an error. */
export function features(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.length <= 16 &&
		value.every((name) => typeof name === "string" && name.length > 0 && name.length <= 64)
	);
}

export interface McpPresenterRegistration {
	readonly id: string;
}
export interface Registration extends McpPresenterRegistration {
	readonly principal: string;
	readonly generation: string;
	readonly binding: Binding;
	readonly connection: Connection;
	readonly kind: McpFormScope["presenterKind"];
	readonly elsewhere: boolean;
	active: boolean;
}
export interface Grant {
	readonly id: string;
	readonly registration: Registration;
	readonly scope: McpFormScope;
	readonly answeredBy: NonNullable<McpFormSettled["answeredBy"]>;
	readonly lifetime: AbortController;
	readonly dialogs: Map<string, McpFormDialog>;
}

/** At most one grant per (principal, connection) on a binding; other holders coexist (D11 S3-3b). */
function holds(binding: Binding, principal: string, connection: Connection): boolean {
	return [...binding.grants].some(
		(grant) => grant.registration.principal === principal && grant.registration.connection === connection,
	);
}

export function enroll(
	state: McpPresenterState,
	principal: string = randomUUID(),
	identity: McpPresenterIdentity = { principalKind: "inherited" },
) {
	const generation = randomUUID();
	return {
		register: (
			handle: McpFormBinding,
			sender: McpPresenterConnection,
			options: { readonly kind: McpFormScope["presenterKind"]; readonly features?: readonly string[] },
		): McpPresenterRegistration => {
			const binding = [...state.bindings.values()].find((value) => value === handle);
			const connection = state.connections.get(sender);
			if (!binding || !connection?.attachments.has(binding) || holds(binding, principal, connection))
				throw new Error("presenter_not_authorized");
			const registration: Registration = {
				id: randomUUID(),
				principal,
				generation,
				binding,
				connection,
				kind: options.kind,
				elsewhere: options.features?.includes(ELSEWHERE_FEATURE) === true,
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
			if (!attachment || binding.lifetime.signal.aborted || holds(binding, principal, connection))
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
				answeredBy: { ...identity, presenterKind: registration.kind },
				lifetime: new AbortController(),
				dialogs: new Map(),
			};
			binding.grants.add(grant);
			binding.presence ??= { id: randomUUID(), lifetime: new AbortController() };
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
		binding.grants.has(grant) &&
		state.connections.get(connection) === connection &&
		connection.attachments.get(binding)?.epoch === scope.attachmentEpoch
	);
}

export function holders(state: McpPresenterState, binding: Binding): Grant[] {
	return [...binding.grants].filter((grant) => current(state, grant));
}

export function revoke(state: McpPresenterState, registration: Registration, operation = false): void {
	registration.active = false;
	state.registrations.delete(registration);
	const binding = registration.binding;
	const grant = [...binding.grants].find((value) => value.registration === registration);
	if (!grant) return;
	binding.grants.delete(grant);
	// Retain entry references after authority is fenced. Cleanup never validates the revoked sender.
	for (const dialog of [...grant.dialogs.values()]) dialog.revoked(operation);
	if (binding.grants.size === 0) {
		binding.presence?.lifetime.abort();
		binding.presence = undefined;
	}
	for (const listener of binding.listeners) listener();
	grant.lifetime.abort();
}
