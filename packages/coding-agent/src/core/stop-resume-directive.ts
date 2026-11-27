import type { CustomMessage } from "./messages.ts";

export const STOP_RESUME_CUSTOM_TYPE = "session-resumed";

const DIRECTIVE =
	"<system-reminder>The user stopped the previous turn and has now resumed. Tool calls that the Stop interrupted show " +
	"an aborted result; they were not re-run and their side effects may be partial. Check their effects before repeating " +
	"any of them, then continue the work.</system-reminder>";

/** What a Resume continues: a person's Stop, an interrupted run, or a session the engine-turn cap paused (senpi#7138). */
export type ResumeCause = "stop" | "interrupted" | "engine_turn_cap";

export function stopResumeDirective(
	cause: ResumeCause = "stop",
): Pick<CustomMessage, "customType" | "content" | "display" | "details"> {
	// A person's go-ahead: it resets the engine-turn count (`resetsEngineTurnHistory`), as their message would.
	if (cause === "engine_turn_cap")
		return {
			customType: STOP_RESUME_CUSTOM_TYPE,
			content:
				"<system-reminder>Automatic turns were paused after the engine-turn limit, and the user has now resumed. " +
				"Answer any message that arrived while paused, then continue the work.</system-reminder>",
			display: false,
			details: { resumeCause: cause },
		};
	if (cause === "interrupted")
		return {
			customType: STOP_RESUME_CUSTOM_TYPE,
			content:
				"<system-reminder>The previous run was interrupted and has now resumed. Interrupted tool calls may have " +
				"partial side effects and were not re-run. Check their effects before repeating any of them, then continue " +
				"the work.</system-reminder>",
			display: false,
			details: { resumeCause: cause },
		};
	return { customType: STOP_RESUME_CUSTOM_TYPE, content: DIRECTIVE, display: false };
}
