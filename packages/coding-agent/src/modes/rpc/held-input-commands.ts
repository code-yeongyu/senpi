import type { AgentSession } from "../../core/agent-session.ts";
import type { RpcCommand } from "./rpc-types.ts";

type HoldInputCommand = Extract<RpcCommand, { type: "hold_input" }>;

export type HeldInputAnswer =
	| { readonly ok: true; readonly data: { entryId?: string; duplicate?: boolean; alreadyDelivered?: boolean } }
	| { readonly ok: false; readonly error: string };

/**
 * Held input speaks for the human: an interactive connection holds it, and the task parent relays a person's run
 * guidance into the child it paused for that run (senpi#3811 design 4.10), naming that parent session.
 */
export function runHoldInput(
	session: AgentSession,
	command: HoldInputCommand,
	roles: { readonly interactiveUser: boolean; readonly taskParent: boolean },
): HeldInputAnswer {
	if (!roles.interactiveUser) {
		if (!roles.taskParent) return { ok: false, error: "hold_input_requires_interactive_client" };
		const pausedByParent = session.pauseView.records.some(
			(record) => record.kind === "inherited_hold" && record.parentSessionId === command.parentSessionId,
		);
		if (!pausedByParent)
			return { ok: false, error: "wrong_parent: this child is not paused for that parent session's run" };
	}
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
