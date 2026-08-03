import type { SDKMessage } from "./sdk-boundary.ts";

export interface SessionTurnResult {
	uuid: string;
	messages: SDKMessage[];
	aborted: boolean;
}

export interface ActiveTurn {
	uuid: string;
	generation: number;
	messages: SDKMessage[];
	preReplay: SDKMessage[];
	preReplayBytes: number;
	claimed: boolean;
	aborted: boolean;
	interruptReceipt?: unknown;
	onMessage?: (message: SDKMessage) => void;
	signal?: AbortSignal;
	onAbort: () => void;
	cancelAbort?: () => void;
	resolve: (result: SessionTurnResult) => void;
	reject: (error: Error) => void;
	limits: PreReplayBufferLimits;
}

export interface PreReplayBufferLimits {
	maxMessages: number;
	maxBytes: number;
}

export class SessionTurnAttributionError extends Error {
	readonly code = "claude_sdk_oauth_turn_attribution";

	constructor(message: string) {
		super(message);
		this.name = "SessionTurnAttributionError";
	}
}
