import type { CustomMessage } from "./messages.ts";

export const STOP_RESUME_CUSTOM_TYPE = "session-resumed";

const DIRECTIVE =
	"<system-reminder>The user stopped the previous turn and has now resumed. Tool calls that the Stop interrupted show " +
	"an aborted result; they were not re-run and their side effects may be partial. Check their effects before repeating " +
	"any of them, then continue the work.</system-reminder>";

export function stopResumeDirective(): Pick<CustomMessage, "customType" | "content" | "display"> {
	return { customType: STOP_RESUME_CUSTOM_TYPE, content: DIRECTIVE, display: false };
}
