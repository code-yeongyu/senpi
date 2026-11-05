import type { McpFormBinding } from "../../core/mcp-form-types.ts";
import type { McpPresenterAuthority, McpPresenterConnection } from "./mcp-presenter-authority.ts";

/**
 * What the presenter control endpoint needs from the host that carries the sessions (senpi#4249, D11 2.9).
 * `SessionEventWriter` implements it for RPC hosts; a terminal host provides its own adapter.
 */
export interface PresenterHostSurface {
	/** The host's presenter authority, enabled on first read. */
	readonly authority: McpPresenterAuthority;
	getMcpFormBinding(sessionId: string): McpFormBinding | undefined;
	findMcpPresenterConnection(nonce: string): McpPresenterConnection | undefined;
	getConnectionCapabilities(id: string): readonly string[] | undefined;
	advertiseMcpPresenterControl(path: string): void;
	withdrawMcpPresenterControl(path: string): void;
}
