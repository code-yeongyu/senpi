import type { Duplex } from "node:stream";
import type { McpFormBinding } from "../../core/mcp-form-types.ts";
import type { AccountPrincipal } from "./mcp-presenter-account.ts";
import type { McpPresenterAuthority, McpPresenterRegistration } from "./mcp-presenter-authority.ts";
import type { PresenterPrincipal } from "./mcp-presenter-enrollment.ts";
import { features, SECRET_INPUT_FEATURE } from "./mcp-presenter-grants.ts";
import type { PresenterHostSurface } from "./mcp-presenter-host-surface.ts";
import { send } from "./mcp-presenter-wire.ts";
import type { SealedSecretHolders } from "./secret-sealed-holders.ts";

/** What one management stream owns once its first signed command enrolls it (D11 S3). */
export type PresenterOwner = ReturnType<McpPresenterAuthority["enroll"]>;

/** An enrolled principal; an account principal is managed only on the stream it enrolled on (D11 S3-2). */
export type PresenterPrincipalRecord =
	| (PresenterPrincipal & { readonly kind: "inherited"; readonly sessions: WeakSet<McpFormBinding> })
	| AccountPrincipal;

export interface PresenterCommandContext {
	readonly host: PresenterHostSurface;
	readonly authority: McpPresenterAuthority;
	readonly stream: Duplex;
	readonly id: string | undefined;
	readonly principal: PresenterPrincipalRecord;
	readonly owner: PresenterOwner;
	readonly registrations: Map<string, McpPresenterRegistration>;
	readonly sealed: SealedSecretHolders | undefined;
}

/**
 * The signed management switch (D11 S3), split out of `McpPresenterControl.manage` for the 250-line ceiling (#5934
 * item 5). A command that is not one of the three throws `presenter_not_authorized`; the caller turns that into the
 * refusal record, so nothing here writes an error frame itself.
 */
export function runPresenterCommand(command: Record<string, unknown>, control: PresenterCommandContext): void {
	const { host, authority, stream, id, principal, owner, registrations, sealed } = control;
	switch (command.type) {
		case "mcp_presenter_assign": {
			const binding = typeof command.sessionId === "string" ? host.getMcpFormBinding(command.sessionId) : undefined;
			if (!binding || binding.epoch !== command.bindingEpoch || command.purpose !== "mcp_form")
				throw new Error("presenter_not_authorized");
			// The inherited supervisor assigns sessions it opened or the user adopted; an account principal
			// assigns itself under D1 while current. Enrollment and RPC attachment never imply assignment.
			principal.sessions.add(binding);
			send(stream, { type: "mcp_presenter_assigned", id, sessionId: command.sessionId });
			return;
		}
		case "mcp_presenter_acquire": {
			if (
				command.hostInstance !== authority.instance ||
				typeof command.sessionId !== "string" ||
				typeof command.bindingEpoch !== "string" ||
				typeof command.connectionNonce !== "string" ||
				(command.kind !== "desktop" && command.kind !== "gateway") ||
				(command.features !== undefined && !features(command.features))
			)
				throw new Error("presenter_not_authorized");
			const binding = host.getMcpFormBinding(command.sessionId);
			const connection = host.findMcpPresenterConnection(command.connectionNonce);
			if (!binding || !principal.sessions.has(binding) || binding.epoch !== command.bindingEpoch || !connection)
				throw new Error("presenter_not_authorized");
			const capabilities = host.getConnectionCapabilities(connection.id);
			if (!capabilities?.includes("interactive_user") || !capabilities.includes("mcp_form_presenter_v1"))
				throw new Error("presenter_not_authorized");
			const context = authority.connectionContext(connection, command.sessionId);
			if (
				!context ||
				command.purpose !== "mcp_form" ||
				command.attachmentId !== context.attachmentId ||
				command.attachmentEpoch !== context.attachmentEpoch
			)
				throw new Error("presenter_not_authorized");
			// `features` is inside the signed transcript, so the grant records only what the principal asked for.
			const registration = owner.register(binding, connection, {
				kind: command.kind,
				features: command.features,
			});
			const grant = owner.acquire(registration);
			registrations.set(registration.id, registration);
			if (features(command.features) && command.features.includes(SECRET_INPUT_FEATURE))
				sealed?.tokens.want(grant.scope.durableSessionId, binding, () => authority.secretInputHeld(binding));
			send(stream, { type: "mcp_presenter_acquired", id, registrationId: registration.id, ...grant });
			return;
		}
		case "mcp_presenter_revoke": {
			const registration =
				typeof command.registrationId === "string" ? registrations.get(command.registrationId) : undefined;
			if (!registration) throw new Error("presenter_not_authorized");
			owner.revoke(registration);
			registrations.delete(registration.id);
			send(stream, { type: "mcp_presenter_revoked", id });
			return;
		}
		default:
			throw new Error("presenter_not_authorized");
	}
}
