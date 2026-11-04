import { bindPrivateMcpForms, type McpFormBinding } from "../../core/mcp-form-types.ts";
import { serializeJsonLine } from "./jsonl.ts";
import { McpPresenterAuthority, type McpPresenterConnection } from "./mcp-presenter-authority.ts";
import type { PresenterHostSurface } from "./mcp-presenter-host-surface.ts";
import { SessionEventWriterConnections } from "./session-event-writer-connections.ts";

/** The MCP form presenter surface; its private-record handler stays in session-event-writer.ts. */
export abstract class SessionEventWriterPresenters
	extends SessionEventWriterConnections
	implements PresenterHostSurface
{
	private presenterControlEndpoint?: string;

	/** Deployment switch. Ordinary RPC behavior is unchanged unless the host explicitly enables it. */
	enableMcpPresenters(): McpPresenterAuthority {
		this.presenterAuthority ??= new McpPresenterAuthority();
		return this.presenterAuthority;
	}

	/** The presenter control's view: reading it enables the authority, as `enableMcpPresenters()` does. */
	get authority(): McpPresenterAuthority {
		return this.enableMcpPresenters();
	}

	get mcpPresenters(): McpPresenterAuthority | undefined {
		return this.presenterAuthority;
	}

	advertiseMcpPresenterControl(path: string): void {
		this.presenterControlEndpoint = path;
	}

	withdrawMcpPresenterControl(path: string): void {
		if (this.presenterControlEndpoint === path) this.presenterControlEndpoint = undefined;
	}

	/** The listening account-enrolling control endpoint, if any (`mcp_presenter_control_info`, senpi#4249 R-1b d2). */
	get mcpPresenterControlEndpoint(): string | undefined {
		return this.presenterControlEndpoint;
	}

	/**
	 * Writes the private reply to `request` straight to the current connection: never an event queue, snapshot,
	 * mirror or replay. A failed write detaches that connection's presenter.
	 */
	writeMcpFormReply(requestId: string | undefined, reply: object): void {
		const id = this.currentConnection();
		const connection = id === undefined ? undefined : this.fanout.get(id)?.connection;
		if (!connection) return;
		try {
			connection.writeRaw(
				serializeJsonLine({
					type: "mcp_form_reply",
					...(requestId === undefined ? {} : { id: requestId }),
					...reply,
				}),
			);
		} catch {
			const sender = id === undefined ? undefined : this.presenterConnections.get(id);
			if (sender) this.presenterAuthority?.detach(sender);
		}
	}

	/**
	 * The `mcp_presenter_context` reply. `controlEndpoint` is added only on an explicit `discover: true` and only
	 * when an account-enrolling control is advertised; otherwise the reply keeps the shape strict clients decode.
	 */
	protected mcpPresenterContextReply(sender: McpPresenterConnection | undefined, request: object): object {
		const sessionId = "sessionId" in request && typeof request.sessionId === "string" ? request.sessionId : undefined;
		const context =
			sender && sessionId !== undefined ? this.presenterAuthority?.connectionContext(sender, sessionId) : undefined;
		if (!context) return { error: "presenter_not_authorized" };
		const discover = "discover" in request && request.discover === true;
		const controlEndpoint = discover ? this.presenterControlEndpoint : undefined;
		return { ok: true, context: controlEndpoint === undefined ? context : { ...context, controlEndpoint } };
	}

	getMcpPresenterConnection(id: string): McpPresenterConnection | undefined {
		return this.presenterConnections.get(id);
	}
	findMcpPresenterConnection(nonce: string): McpPresenterConnection | undefined {
		return [...this.presenterConnections.values()].find((connection) => connection.nonce === nonce);
	}

	getMcpFormBinding(sessionId: string): McpFormBinding | undefined {
		return this.presenterBindings.get(sessionId);
	}

	bindMcpForms(
		sessionId: string,
		durableId: string,
		ui: object,
		admit: () => void,
	): (() => void) | undefined | Promise<(() => void) | undefined> {
		const authority = this.presenterAuthority;
		if (!authority) return undefined;
		const binding = authority.bind(sessionId, durableId, admit);
		this.presenterBindings.set(sessionId, binding);
		for (const id of this.fanout.attachedConnections(sessionId)) {
			const connection = this.presenterConnections.get(id);
			if (connection) authority.attach(connection, binding);
		}
		bindPrivateMcpForms(ui, binding);
		return () => {
			binding.dispose();
			if (this.presenterBindings.get(sessionId) === binding) this.presenterBindings.delete(sessionId);
		};
	}
}
