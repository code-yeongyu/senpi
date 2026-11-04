import { bindPrivateMcpForms, type McpFormBinding } from "../../core/mcp-form-types.ts";
import { McpPresenterAuthority, type McpPresenterConnection } from "./mcp-presenter-authority.ts";
import { type PresenterHostSurface, presenterContextReply } from "./mcp-presenter-host-surface.ts";
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

	protected mcpPresenterContextReply(sender: McpPresenterConnection | undefined, request: object): object {
		return presenterContextReply(this.presenterAuthority, sender, request, this.presenterControlEndpoint);
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
