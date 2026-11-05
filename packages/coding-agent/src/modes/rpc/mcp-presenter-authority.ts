import { hostInstanceId } from "./protocol-identity.ts";
import type { McpFormBinding, McpPresenterIdentity } from "../../core/mcp-form-types.ts";
import { mcpFormClock, type McpFormClock, type McpPresenterReply } from "./mcp-form-dialog.ts";
import * as presenterBindings from "./mcp-presenter-bindings.ts";
import type {
	McpPresenterConnection,
	McpPresenterConnectionContext,
	McpPresenterState,
	Sender,
} from "./mcp-presenter-bindings.ts";
import * as presenterForms from "./mcp-presenter-forms.ts";
import * as presenterGrants from "./mcp-presenter-grants.ts";

export type { McpPresenterConnection } from "./mcp-presenter-bindings.ts";
export type { McpPresenterRegistration } from "./mcp-presenter-grants.ts";

/** Host-owned only. No public session command can call enrollment or install a registration. */
export class McpPresenterAuthority {
	/** The host process this authority belongs to: its protocol `instanceId`, so a launcher can name the host it replaces. */
	readonly instance = hostInstanceId();
	private readonly state: McpPresenterState;

	constructor(options: { readonly clock?: McpFormClock } = {}) {
		this.state = {
			instance: this.instance,
			clock: options.clock ?? mcpFormClock,
			connections: new Map(),
			bindings: new Map(),
			registrations: new Map(),
		};
	}
	dispose(): void {
		presenterBindings.dispose(this.state);
	}

	connect(id: string, send: Sender): McpPresenterConnection {
		return presenterBindings.connect(this.state, id, send);
	}

	attach(sender: McpPresenterConnection, handle: McpFormBinding): void {
		presenterBindings.attach(this.state, sender, handle);
	}

	connectionContext(sender: McpPresenterConnection, sessionId: string): McpPresenterConnectionContext | undefined {
		return presenterBindings.connectionContext(this.state, sender, sessionId);
	}

	detach(sender: McpPresenterConnection, handle?: McpFormBinding): void {
		presenterBindings.detach(this.state, sender, handle);
	}
	withdraw(sender: McpPresenterConnection): void {
		presenterBindings.withdraw(this.state, sender);
	}

	bind(sessionId: string, durableId: string, admit: () => void): McpFormBinding {
		return presenterBindings.bind(this.state, sessionId, durableId, admit);
	}

	/** Called only after the protected bootstrap has pinned and authenticated its launch principal. */
	enroll(principal?: string, identity?: McpPresenterIdentity) {
		return presenterGrants.enroll(this.state, principal, identity);
	}

	receive(sender: McpPresenterConnection, value: unknown): McpPresenterReply {
		return presenterForms.receive(this.state, sender, value);
	}
}
