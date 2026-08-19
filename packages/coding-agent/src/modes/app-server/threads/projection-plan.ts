import type { TurnPlanStep, TurnPlanStepStatus } from "../protocol/notifications.ts";

const TODO_TOOL_NAME = "todo";

/**
 * Extracts Codex plan steps from a completed todo tool result. Returns
 * `undefined` when the result carries no structured `details.phases` array, so
 * turns without a plan emit nothing. Malformed phases/tasks are skipped rather
 * than invented.
 */
export function todoPlanSteps(toolName: string, result: unknown): TurnPlanStep[] | undefined {
	if (toolName !== TODO_TOOL_NAME || !isRecord(result) || !isRecord(result.details)) return undefined;
	const phases = result.details.phases;
	if (!Array.isArray(phases)) return undefined;
	const steps: TurnPlanStep[] = [];
	for (const phase of phases) {
		if (!isRecord(phase) || !Array.isArray(phase.tasks)) continue;
		for (const task of phase.tasks) {
			if (!isRecord(task) || typeof task.content !== "string") continue;
			const status = planStepStatus(task.status);
			if (status === undefined) continue;
			steps.push({ step: task.content, status });
		}
	}
	return steps;
}

function planStepStatus(status: unknown): TurnPlanStepStatus | undefined {
	switch (status) {
		case "pending":
			return "pending";
		case "in_progress":
			return "inProgress";
		case "completed":
		case "abandoned":
			return "completed";
		default:
			return undefined;
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
