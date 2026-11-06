import { bindPrivateMcpForms, type McpFormBinding } from "../../core/mcp-form-types.ts";
import { serializeJsonLine } from "./jsonl.ts";
import { McpPresenterAuthority, type McpPresenterConnection } from "./mcp-presenter-authority.ts";
import { type PresenterHostSurface, presenterContextReply } from "./mcp-presenter-host-surface.ts";
import type { SealedSecretSource } from "./secret-sealed-holders.ts";
import { SessionEventWriterConnections } from "./session-event-writer-connections.ts";

/** The MCP form presenter surface and its private-record handler (MCP forms and sealed secret answers). */
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

	attachSealedSecrets(source: SealedSecretSource): () => void {
		return this.secretPresentations.useSealed(source);
	}

	/**
	 * The `mcp_presenter_context` reply. `controlEndpoint` is added only on an explicit `discover: true` and only
	 * when an account-enrolling control is advertised; otherwise the reply keeps the shape strict clients decode.
	 */
	protected mcpPresenterContextReply(sender: McpPresenterConnection | undefined, request: object): object {
		return presenterContextReply(this.presenterAuthority, sender, request, this.presenterControlEndpoint);
	}

	/** Private records bypass event queues, snapshots, mirrors, replay, and overflow preview errors. */
	handleMcpForm(value: unknown): boolean {
		if (!this.presenterAuthority) return false;
		if (
			typeof value !== "object" ||
			value === null ||
			!("type" in value) ||
			typeof value.type !== "string" ||
			(!value.type.startsWith("mcp_form_") &&
				value.type !== "mcp_presenter_context" &&
				value.type !== "mcp_presenter_secret_answer")
		)
			return false;
		const id = this.currentConnection();
		const connection = id === undefined ? undefined : this.fanout.get(id)?.connection;
		if (value.type === "mcp_presenter_secret_answer") {
			const lineId = "id" in value && typeof value.id === "string" ? { id: value.id } : {};
			// D11 secret phase 5.3: the reply goes to the sender only, never an event, snapshot, mirror or replay lane.
			if (id !== undefined && connection)
				void this.secretPresentations
					.answerSealed(id, value)
					.catch(() => ({ error: "secret_answer_refused" as const }))
					.then((reply) => {
						try {
							connection.writeRaw(
								serializeJsonLine({ ...reply, type: "mcp_presenter_secret_reply", ...lineId }),
							);
						} catch {
							// A closed connection simply misses its reply; the request's own state is unaffected.
						}
					});
			return true;
		}
		const sender = id === undefined ? undefined : this.presenterConnections.get(id);
		const reply =
			value.type === "mcp_presenter_context"
				? this.mcpPresenterContextReply(sender, value)
				: sender && this.presenterAuthority
					? this.presenterAuthority.receive(sender, value)
					: { error: "presenter_not_authorized" };
		this.writeMcpFormReply("id" in value && typeof value.id === "string" ? value.id : undefined, reply);
		return true;
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
