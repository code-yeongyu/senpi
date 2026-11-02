// Ported and adapted from oh-my-pi's todo tool (MIT License).
// Copyright (c) 2025 Mario Zechner
// Copyright (c) 2025-2026 Can Bölük
// https://github.com/can1357/oh-my-pi

import { fuzzyResolvePhase, fuzzyResolveTask } from "./fuzzy-match.ts";
import { findPhaseByName, findTaskByContent, type TaskHit } from "./todo-query.ts";
import type { TodoItem, TodoOpEntry, TodoPhase } from "./todo-types.ts";

export function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
	corrections?: string[],
): TaskHit | undefined {
	if (!content) {
		errors.push("Missing task content");
		return undefined;
	}
	if (!corrections) {
		const hit = findTaskByContent(phases, content);
		if (!hit) {
			if (/^task-\d+$/.test(content)) {
				errors.push(
					`Task "${content}" not found. Tasks are referenced by content, not by IDs: pass the task's full text from the previous result.`,
				);
			} else {
				const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
				const hint = totalTasks === 0 ? " (todo list is empty: was it replaced or not yet created?)" : "";
				errors.push(`Task "${content}" not found${hint}`);
			}
		}
		return hit;
	}

	const resolution = fuzzyResolveTask(phases, content);
	if (resolution.hit) {
		if (resolution.corrected) {
			corrections.push(
				`[auto-matched] task "${content}" -> "${resolution.hit.task.content}": pass the exact text from the previous todo result next time`,
			);
		}
		return resolution.hit;
	}

	const exactMatches = phases.flatMap((phase) =>
		phase.tasks.filter((task) => task.content === content).map((task) => ({ task, phase })),
	);
	if (exactMatches.length > 1) {
		const phaseNames = [...new Set(exactMatches.map((match) => match.phase.name))].map((name) => `"${name}"`);
		errors.push(
			`Task "${content}" is ambiguous: duplicate task text exists in phases ${phaseNames.join(", ")}. Use /todo edit to make the task text unique.`,
		);
		return undefined;
	}
	if (/^task-\d+$/.test(content)) {
		errors.push(
			`Task "${content}" not found. Tasks are referenced by content, not by IDs: pass the task's full text from the previous result.`,
		);
		return undefined;
	}
	const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
	const hint = totalTasks === 0 ? " (todo list is empty: was it replaced or not yet created?)" : "";
	const suggestion = resolution.suggestion ? ` Did you mean "${resolution.suggestion}"?` : "";
	errors.push(`Task "${content}" not found${hint}${suggestion}`);
	return undefined;
}

export function resolvePhaseOrError(
	phases: TodoPhase[],
	name: string | undefined,
	errors: string[],
	corrections?: string[],
): TodoPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	if (!corrections) {
		const phase = findPhaseByName(phases, name);
		if (!phase) errors.push(`Phase "${name}" not found`);
		return phase;
	}

	const resolution = fuzzyResolvePhase(phases, name);
	if (resolution.hit) {
		if (resolution.corrected) {
			corrections.push(
				`[auto-matched] phase "${name}" -> "${resolution.hit.name}": pass the exact text from the previous todo result next time`,
			);
		}
		return resolution.hit;
	}
	if (phases.filter((phase) => phase.name === name).length > 1) {
		errors.push(
			`Phase "${name}" is ambiguous: duplicate phase names exist. Use /todo edit to make the phase name unique.`,
		);
		return undefined;
	}
	const suggestion = resolution.suggestion ? ` Did you mean "${resolution.suggestion}"?` : "";
	errors.push(`Phase "${name}" not found${suggestion}`);
	return undefined;
}

export function getTaskTargets(
	phases: TodoPhase[],
	entry: TodoOpEntry,
	errors: string[],
	corrections?: string[],
): TodoItem[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors, corrections);
		return hit ? [hit.task] : [];
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors, corrections);
		return phase ? [...phase.tasks] : [];
	}
	return phases.flatMap((phase) => phase.tasks);
}
