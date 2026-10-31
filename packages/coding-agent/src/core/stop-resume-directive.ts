import type { CustomMessage } from "./messages.ts";

export const STOP_RESUME_CUSTOM_TYPE = "session-resumed";

const DIRECTIVE =
	"<system-reminder>The user stopped the previous turn and has now resumed. Tool calls that the Stop interrupted show " +
	"an aborted result; they were not re-run and their side effects may be partial. Check their effects before repeating " +
	"any of them, then continue the work.</system-reminder>";

export function stopResumeDirective(
	cause: "stop" | "interrupted" = "stop",
): Pick<CustomMessage, "customType" | "content" | "display" | "details"> {
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
