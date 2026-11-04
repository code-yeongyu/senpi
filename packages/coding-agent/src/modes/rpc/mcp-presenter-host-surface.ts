import type { McpFormBinding } from "../../core/mcp-form-types.ts";
import type { McpPresenterAuthority, McpPresenterConnection } from "./mcp-presenter-authority.ts";

/**
 * What the presenter control endpoint needs from the host that carries the sessions (senpi#4249, D11 2.9).
 * `SessionEventWriter` implements it for RPC hosts; a terminal host provides its own adapter.
 */
export interface PresenterHostSurface {
	/** The host's presenter authority, enabled on first read. */
	readonly authority: McpPresenterAuthority;
	/** True when the authority outlives the control (a terminal's own presenter): stopping it revokes only its grants. */
	readonly sharedAuthority?: boolean;
	getMcpFormBinding(sessionId: string): McpFormBinding | undefined;
	findMcpPresenterConnection(nonce: string): McpPresenterConnection | undefined;
	getConnectionCapabilities(id: string): readonly string[] | undefined;
	advertiseMcpPresenterControl(path: string): void;
	withdrawMcpPresenterControl(path: string): void;
}

/**
 * The `mcp_presenter_context` reply. `controlEndpoint` is added only on an explicit `discover: true` and only when an
 * account-enrolling control is advertised; otherwise the reply keeps the shape strict clients decode.
 */
export function presenterContextReply(
	authority: McpPresenterAuthority | undefined,
	sender: McpPresenterConnection | undefined,
	request: object,
	advertised: string | undefined,
): object {
	const sessionId = "sessionId" in request && typeof request.sessionId === "string" ? request.sessionId : undefined;
	const context = sender && sessionId !== undefined ? authority?.connectionContext(sender, sessionId) : undefined;
	if (!context) return { error: "presenter_not_authorized" };
	const discover = "discover" in request && request.discover === true;
	const controlEndpoint = discover ? advertised : undefined;
	return { ok: true, context: controlEndpoint === undefined ? context : { ...context, controlEndpoint } };
}
