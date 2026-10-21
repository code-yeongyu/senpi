import type { AgentSession } from "../../core/agent-session.ts";
import type { RpcCommand } from "./rpc-types.ts";

type HoldInputCommand = Extract<RpcCommand, { type: "hold_input" }>;

export type HeldInputAnswer =
	| { readonly ok: true; readonly data: { entryId?: string; duplicate?: boolean; alreadyDelivered?: boolean } }
	| { readonly ok: false; readonly error: string };

/** Only an interactive connection speaks for the human, so only it may hold input for later delivery. */
export function runHoldInput(
	session: AgentSession,
	command: HoldInputCommand,
	interactiveUser: boolean,
): HeldInputAnswer {
	if (!interactiveUser) return { ok: false, error: "hold_input_requires_interactive_client" };
	const result = session.holdInput({ inputId: command.inputId, revision: command.revision, text: command.text });
	switch (result.kind) {
		case "held":
			return { ok: true, data: { entryId: result.entryId, duplicate: result.duplicate } };
		case "already_delivered":
			return { ok: true, data: { alreadyDelivered: true } };
		case "input_id_conflict":
			return {
				ok: false,
				error: `input_id_conflict: input ${command.inputId} is held at revision ${result.heldRevision}`,
			};
	}
}
