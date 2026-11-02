import { bindPrivateMcpForms, type McpFormBinding } from "../../core/mcp-form-types.ts";
import { McpPresenterAuthority, type McpPresenterConnection } from "./mcp-presenter-authority.ts";
import { SessionEventWriterConnections } from "./session-event-writer-connections.ts";

/** The MCP form presenter surface; its private-record handler stays in session-event-writer.ts. */
export abstract class SessionEventWriterPresenters extends SessionEventWriterConnections {
	/** Deployment switch. Ordinary RPC behavior is unchanged unless the host explicitly enables it. */
	enableMcpPresenters(): McpPresenterAuthority {
		this.presenterAuthority ??= new McpPresenterAuthority();
		return this.presenterAuthority;
	}

	get mcpPresenters(): McpPresenterAuthority | undefined {
		return this.presenterAuthority;
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
