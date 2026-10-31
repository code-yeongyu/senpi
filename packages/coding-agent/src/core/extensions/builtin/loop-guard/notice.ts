import type { LoopGuardDetection } from "./detectors.ts";
import type { FailedRepeatDetection } from "./failure-repeats.ts";
import { FAILED_REPEAT_STOP_THRESHOLD } from "./policy.ts";

export const LOOP_GUARD_NOTICE_CUSTOM_TYPE = "loop-guard:notice";
export const LOOP_GUARD_ESCALATION_CUSTOM_TYPE = "loop-guard:escalation";
export const LOOP_GUARD_RECOVERY_CUSTOM_TYPE = "loop-guard:recovery";

export type LoopGuardNoticeDetails = LoopGuardDetection | FailedRepeatDetection;

/** Why the loop guard interrupted a turn. */
export type LoopGuardStopReason = "blocked-repeats" | "failed-repeats";

export type LoopGuardEscalationDetails =
	| { readonly reason: "blocked-repeats"; readonly toolName: string; readonly blockedCallCount: number }
	| { readonly reason: "failed-repeats"; readonly toolName: string; readonly failedCallCount: number };

const POLLING_TOOL_NAMES = new Set(["bash_output", "task_output"]);

export function buildLoopGuardBlockReason(toolName: string, blockedCallCount: number): string {
	const recovery = POLLING_TOOL_NAMES.has(toolName)
		? "Stop polling this target. If you need to wait for a change, arm a monitor or rely on a completion notification when this mode supports it; otherwise re-plan or choose a different tool."
		: "Reuse the existing result, stop repeating this call, and re-plan from the current goal or choose a different tool.";
	return [
		`Loop guard blocked repeated call ${blockedCallCount} to \`${toolName}\` with arguments that already triggered two identical-call warnings.`,
		recovery,
	].join(" ");
}

export function buildLoopGuardHardStopWarning(toolName: string, blockedCallCount: number): string {
	return `Loop guard interrupted the turn after blocking ${blockedCallCount} repeated calls to ${toolName}.`;
}

export function buildLoopGuardHardStopSteer(toolName: string): string {
	return [
		`The loop guard stopped the previous turn because you kept calling \`${toolName}\` with arguments that had already been blocked.`,
		"Do not repeat that call. Re-plan from the current goal and use a different tool or deliberately changed arguments.",
	].join(" ");
}

export function buildLoopGuardFailedRepeatWarning(toolName: string, failedCallCount: number): string {
	return `Loop guard interrupted the turn after ${failedCallCount} identical calls to ${toolName} failed in a row.`;
}

export function buildLoopGuardFailedRepeatSteer(toolName: string): string {
	return [
		`The loop guard stopped the previous turn because the same \`${toolName}\` call kept failing with identical arguments.`,
		"Do not resend it. Read the last error, fix the arguments it names or use a different tool, then re-plan from the current goal.",
	].join(" ");
}

export function buildLoopGuardFailedRepeatReminder(detection: FailedRepeatDetection): string {
	const { toolName, count } = detection;
	return [
		`<system-reminder>`,
		`LOOP GUARD - IDENTICAL FAILING CALLS: your last ${count} calls to \`${toolName}\` used the EXACT same arguments and every one failed. Resending the same call fails the same way.`,
		`- read the error of the last result and fix what it names (a missing or invalid argument, a wrong value or path) before calling \`${toolName}\` again;`,
		`- if you cannot tell what is wrong, choose a different tool or state what is blocking you.`,
		`If this identical call fails ${FAILED_REPEAT_STOP_THRESHOLD} times in a row, the turn is stopped.`,
		`</system-reminder>`,
	].join("\n");
}

export function buildLoopGuardReminder(detection: LoopGuardDetection): string {
	switch (detection.kind) {
		case "identical": {
			const { toolName, count } = detection;
			return [
				`<system-reminder>`,
				`LOOP GUARD - IDENTICAL TOOL CALLS: you called \`${toolName}\` ${count} times in a row with the EXACT same arguments. This is the tool-call stream, not consecutive text - another tool ran between these calls and it changed nothing about your plan. Re-issuing the same call returns the same result. Snap out of it:`,
				`- reuse the result you already received from this exact call;`,
				`- if you were re-checking for new output or state, switch to the monitor/watch tool or change one parameter deliberately (filter, offset, query);`,
				`- if nothing is actually changing, stop calling this tool, state what is blocking you, and try a different tool or ask the user.`,
				`Do not call \`${toolName}\` again with identical arguments.`,
				`</system-reminder>`,
			].join("\n");
		}
		case "similar": {
			const { toolName, count, similarity } = detection;
			const percent = Math.round(similarity * 100);
			return [
				`<system-reminder>`,
				`LOOP GUARD - NEAR-IDENTICAL TOOL CALLS: your last ${count} calls to \`${toolName}\` had arguments about ${percent}% identical (bigram similarity over canonical args). This may be legitimate batch work - or it may be a lazy loop that only LOOKS like progress. Attention check:`,
				`- if these calls target genuinely different inputs (distinct files, queries, offsets), continue deliberately - but consider batching or widening the scope instead of one call per tiny variation;`,
				`- if you are scanning output incrementally (reads, peeks, polls), widen the window once or use the monitor/watch tool rather than nudging parameters;`,
				`- if the results keep saying the same thing, change strategy now - a different tool, a wider query, or asking the user beats a sixth near-copy.`,
				`</system-reminder>`,
			].join("\n");
		}
		case "cycle": {
			const { period, count, cycleTools } = detection;
			const pattern = cycleTools.join(" -> ");
			return [
				`<system-reminder>`,
				`LOOP GUARD - REPEATING TOOL-CALL PATTERN: your recent tool calls repeat the cycle [${pattern}] ${count} times (period ${period}), with other calls possibly interleaved between repetitions. A fixed rotation usually means waiting, guessing, or searching without a discriminator:`,
				`- if this is a wait/poll rotation (spawn then peek, write then check), replace the rotation with the monitor/watch tool and react to the decisive event instead;`,
				`- if this is a search rotation, change ONE axis decisively: broader query, different tool, or a different source - repeating the same rotation at the same parameters will not find new information;`,
				`- if the cycle is genuinely progressing (each rotation moves distinct work forward), keep going - but say what each rotation accomplished so the next rotation can end.`,
				`</system-reminder>`,
			].join("\n");
		}
	}
}
