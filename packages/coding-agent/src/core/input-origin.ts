import { isUserDirectedTurn } from "./engine-turn-limit.ts";
import type { InputAttribution, InputSource } from "./extensions/types.ts";

/**
 * Who started an input, classified once at its entry point (senpi#3853):
 * - `person`: RPC prompt / steer / follow_up / answer and TUI submit;
 * - `extension`: extension API sends (`pi.sendUserMessage`);
 * - `engine`: goal, monitor, codemode and other automation turns.
 */
export type InputOrigin = "person" | "extension" | "engine";

export function inputOriginOf(source: InputSource | undefined): InputOrigin {
	return source === "extension" ? "extension" : "person";
}

/** What attribution needs to know about an input: who started it, its channel, and for RPC the connection's role. */
export interface AttributedInput {
	readonly origin: InputOrigin;
	readonly source: InputSource | undefined;
	/** RPC input only: the sending connection declared `interactive_user` with `set_client_info`. */
	readonly interactiveUser?: boolean;
}

/**
 * The `input` event's attribution. Extension and engine input is an agent's. RPC input is the user's only when its
 * connection declared `interactive_user`; any other RPC client (a parent agent driving a child session) is an agent.
 * Every other person's input (TUI, a person's answer delivered through the extension API) is the user's.
 */
export function inputAttributionOf(input: AttributedInput): InputAttribution {
	if (input.origin !== "person") return "agent";
	if (input.source === "rpc") return input.interactiveUser === true ? "user" : "agent";
	return "user";
}

export function customTurnOrigin(customType: string): InputOrigin {
	return isUserDirectedTurn(customType) ? "person" : "engine";
}
