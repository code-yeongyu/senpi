import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentEndEvent } from "./extensions/types.ts";

type AbortSource = NonNullable<AgentEndEvent["abortSource"]>;

export type JoinedAbort = {
	readonly abortCurrentAgent: boolean;
	readonly userOwned: boolean;
};

export class AgentAbortProvenance {
	#source: AbortSource | undefined;
	#agentEndEvent: AgentEndEvent | undefined;
	#settlingAgentEndEvent: AgentEndEvent | undefined;
	#agentEndBoundaryOpen = false;
	#lateUserJoin = false;
	#lateUserJoinDelivered = false;

	get hasOpenAgentEndBoundary(): boolean {
		return this.#agentEndBoundaryOpen || this.#agentEndEvent !== undefined;
	}

	begin(source: AbortSource): boolean {
		this.#source = source;
		this.#settlingAgentEndEvent = undefined;
		this.#agentEndBoundaryOpen = false;
		this.#lateUserJoin = false;
		this.#lateUserJoinDelivered = false;
		return source === "user";
	}

	join(source: AbortSource, isStreaming: boolean): JoinedAbort {
		if (source === "user" && (this.#agentEndEvent !== undefined || this.#agentEndBoundaryOpen)) {
			this.#source = "user";
			if (!this.#lateUserJoinDelivered) this.#lateUserJoin = true;
			const event = this.#agentEndEvent ?? this.#settlingAgentEndEvent;
			if (event !== undefined) {
				event.aborted = true;
				event.abortSource = "user";
			}
			return { abortCurrentAgent: false, userOwned: true };
		}
		if (source === "user" && this.#source !== undefined) {
			this.#source = "user";
			return { abortCurrentAgent: false, userOwned: true };
		}
		if (this.#source === undefined) {
			if (!isStreaming) return { abortCurrentAgent: false, userOwned: false };
			this.#source = source;
			return { abortCurrentAgent: true, userOwned: source === "user" };
		}
		return { abortCurrentAgent: false, userOwned: false };
	}

	beginAgentEnd(messages: AgentMessage[], willRetry: boolean, abortedWithoutSource: boolean): AgentEndEvent {
		const event: AgentEndEvent = {
			type: "agent_end",
			messages,
			willRetry,
			...(this.#source !== undefined || abortedWithoutSource ? { aborted: true } : {}),
			...(this.#source === undefined ? {} : { abortSource: this.#source }),
		};
		this.#agentEndEvent = event;
		this.#settlingAgentEndEvent = undefined;
		this.#agentEndBoundaryOpen = false;
		this.#lateUserJoin = false;
		this.#lateUserJoinDelivered = false;
		return event;
	}

	endAgentEnd(event: AgentEndEvent): void {
		if (this.#agentEndEvent === event) {
			this.#agentEndEvent = undefined;
			this.#settlingAgentEndEvent = event;
			this.#agentEndBoundaryOpen = true;
		}
		this.#source = undefined;
	}

	takeLateUserJoin(): boolean {
		const lateUserJoin = this.#lateUserJoin;
		this.#lateUserJoin = false;
		if (lateUserJoin) this.#lateUserJoinDelivered = true;
		return lateUserJoin;
	}

	closeAgentEndBoundary(): void {
		this.#agentEndBoundaryOpen = false;
		this.#settlingAgentEndEvent = undefined;
	}

	joinOpenBoundary(source: AbortSource): JoinedAbort | undefined {
		if (!this.#agentEndBoundaryOpen && this.#agentEndEvent === undefined) return undefined;
		return this.join(source, false);
	}
}
