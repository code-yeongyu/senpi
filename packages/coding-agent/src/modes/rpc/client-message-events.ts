import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import { type ClientMessageIdentity, readClientMessageIdentity } from "../../core/client-message-identity.ts";

export const clientInputContext = new AsyncLocalStorage<ClientMessageIdentity>();

/** Resolve a turn's input metadata without changing the order of its event prefix. */
export class ClientMessageEvents {
	private prefix: AgentSessionEvent[] | undefined;
	private inputs: ClientMessageIdentity[] = [];
	private active: ClientMessageIdentity[] = [];
	private sawUser = false;
	private readonly emit: (event: object) => void;
	private readonly enabled: () => boolean;

	constructor(emit: (event: object) => void, enabled: () => boolean) {
		this.emit = emit;
		this.enabled = enabled;
	}

	accept<T extends AgentSessionEvent>(event: T): void {
		if (!this.enabled()) {
			this.emit(event);
			return;
		}
		if (event.type === "skill_invocation" || event.type === "command_invocation") {
			this.emit({ ...event, ...clientInputContext.getStore() });
			return;
		}
		if (event.type === "turn_start") {
			this.flush();
			this.prefix = [];
			this.inputs = [];
			this.sawUser = false;
		}
		// A turn whose input is a custom message (a trigger turn, an extension steer) answers that
		// message, not the last client input, so it must not inherit the previous correlation.
		if (event.type === "message_start" && event.message.role === "custom" && !this.sawUser) this.active = [];
		if (event.type === "message_start" && event.message.role === "user") {
			if (!this.sawUser) this.active = [];
			this.sawUser = true;
			const identity = readClientMessageIdentity(event.message);
			if (identity.clientMessageId !== undefined || identity.clientTurnId !== undefined) this.inputs.push(identity);
			this.active = this.inputs;
			this.flush();
		}
		if (
			(event.type === "message_start" && event.message.role === "assistant") ||
			event.type === "agent_end" ||
			event.type === "agent_idle"
		) {
			this.flush();
		}
		if (this.prefix) {
			this.prefix.push(event);
		} else {
			this.output(event);
		}
	}

	private flush(): void {
		if (!this.prefix) return;
		if (this.sawUser) this.active = this.inputs;
		const prefix = this.prefix;
		this.prefix = undefined;
		for (const event of prefix) this.output(event);
	}

	private output(event: AgentSessionEvent): void {
		const identity =
			"message" in event && event.message.role === "user"
				? readClientMessageIdentity(event.message)
				: this.active.at(-1);
		const correlated =
			event.type === "turn_start" ||
			event.type === "turn_end" ||
			event.type.startsWith("message_") ||
			event.type.startsWith("tool_execution_") ||
			(event.type === "entry_appended" && event.entry.type === "message") ||
			event.type === "session_abort" ||
			event.type === "agent_end";
		this.emit(
			correlated && identity
				? { ...event, ...identity, ...(this.active.length > 1 ? { clientMessages: this.active } : {}) }
				: event,
		);
	}
}
