import type { AgentSession } from "../../core/agent-session.ts";

type InputCommand = { readonly id?: string; readonly type: "prompt" | "steer" | "follow_up"; readonly message: string };

/**
 * Input from a connection that never declared `interactive_user` is automatic (senpi#3811 design 4.4): while the
 * user's Stop or a parent's run hold is live it is kept as a notice and does not release the pause. An `unattended`
 * hold alone keeps #3860's behavior, so clients that predate the role still resume an unattended open.
 */
export function holdAutomaticInput(session: AgentSession, command: InputCommand, interactiveUser: boolean): boolean {
	if (interactiveUser) return false;
	return session.noteAutomaticInput(command.message);
}
