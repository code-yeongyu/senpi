import type { AgentSession } from "./agent-session.ts";

export interface HumanInputAdmission {
	readonly kind: "prompt" | "steer" | "follow_up" | "answer" | "resume";
	readonly at: string;
}

/**
 * One integration seam for #3811's admission hook.
 * Never infer origin from a role=user message or a generic RPC input.
 */
export function bindLifecycleHumanInput(
	session: AgentSession,
	listener: (event: HumanInputAdmission) => void,
): () => void {
	return session.onHumanInputAdmitted((event) =>
		listener({
			kind: event.kind,
			at: new Date(event.at).toISOString(),
		}),
	);
}
