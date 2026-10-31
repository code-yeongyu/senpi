import type { AgentSession } from "../../core/agent-session.ts";
import type { RpcCommand } from "./rpc-types.ts";

type PauseForRun = Extract<RpcCommand, { type: "pause_for_run" }>;
type ResumeForRun = Extract<RpcCommand, { type: "resume_for_run" }>;
type Answer<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

const NOT_TASK_PARENT =
	"task_parent_required: only the connection that owns this task child may pause or resume it for a run";

export async function runPauseForRun(
	session: AgentSession,
	command: PauseForRun,
	taskParent: boolean,
): Promise<Answer<{ held: true; childSeq: number }>> {
	if (!taskParent) return { ok: false, error: NOT_TASK_PARENT };
	const result = await session.pauseForRun(command);
	if ("refused" in result)
		return { ok: false, error: "wrong_parent: this child is paused for another parent session" };
	return { ok: true, data: { held: true, childSeq: result.childSeq } };
}

export async function runResumeForRun(
	session: AgentSession,
	command: ResumeForRun,
	taskParent: boolean,
): Promise<Answer<{ released: boolean; reason?: "stale" | "not_held"; otherHoldLive?: boolean; turnId?: string }>> {
	if (!taskParent) return { ok: false, error: NOT_TASK_PARENT };
	const result = await session.resumeForRun(command);
	if (!result.released) {
		if (result.reason === "wrong_parent") {
			return { ok: false, error: "wrong_parent: this child is paused for another parent session" };
		}
		return { ok: true, data: { released: false, reason: result.reason } };
	}
	return {
		ok: true,
		data: {
			released: true,
			otherHoldLive: result.otherHoldLive,
			...(result.turnId === undefined ? {} : { turnId: result.turnId }),
		},
	};
}
