import { sanitizeTodoText, type TodoItem, type TodoPhase } from "./state.ts";

type TaskHit = {
	task: TodoItem;
	phase: TodoPhase;
};

export type FuzzyTaskResolution = {
	hit?: TaskHit;
	corrected: boolean;
	suggestion?: string;
};

export type FuzzyPhaseResolution = {
	hit?: TodoPhase;
	corrected: boolean;
	suggestion?: string;
};

function normalized(text: string): string {
	return sanitizeTodoText(text).toLowerCase();
}

function diceCoefficient(left: string, right: string): number {
	if (left === right) return 1;
	if (left.length < 2 || right.length < 2) return 0;
	const pairs = new Map<string, number>();
	for (let index = 0; index < left.length - 1; index += 1) {
		const pair = left.slice(index, index + 2);
		pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
	}
	let overlap = 0;
	for (let index = 0; index < right.length - 1; index += 1) {
		const pair = right.slice(index, index + 2);
		const count = pairs.get(pair) ?? 0;
		if (count > 0) {
			overlap += 1;
			pairs.set(pair, count - 1);
		}
	}
	return (2 * overlap) / (left.length + right.length - 2);
}

function suggestionFor<T>(
	candidates: readonly T[],
	query: string,
	contentOf: (candidate: T) => string,
): string | undefined {
	const normalizedQuery = normalized(query);
	if (!normalizedQuery) return undefined;
	let suggestion: string | undefined;
	let bestScore = 0;
	for (const candidate of candidates) {
		const content = contentOf(candidate);
		const normalizedContent = normalized(content);
		if (!normalizedContent) continue;
		const score =
			normalizedContent.includes(normalizedQuery) || normalizedQuery.includes(normalizedContent)
				? 1
				: diceCoefficient(normalizedContent, normalizedQuery);
		if (score >= 0.5 && score > bestScore) {
			bestScore = score;
			suggestion = content;
		}
	}
	return suggestion;
}

export function fuzzyResolveTask(phases: readonly TodoPhase[], query: string): FuzzyTaskResolution {
	const candidates = phases.flatMap((phase) => phase.tasks.map((task) => ({ task, phase })));
	const exactMatches = candidates.filter(({ task }) => task.content === query);
	if (exactMatches.length === 1) return { hit: exactMatches[0], corrected: false };

	const normalizedQuery = normalized(query);
	const normalizedMatches = candidates.filter(({ task }) => normalized(task.content) === normalizedQuery);
	if (normalizedMatches.length === 1) return { hit: normalizedMatches[0], corrected: true };

	const suggestion = suggestionFor(candidates, query, ({ task }) => task.content);
	return suggestion ? { corrected: false, suggestion } : { corrected: false };
}

export function fuzzyResolvePhase(phases: readonly TodoPhase[], name: string): FuzzyPhaseResolution {
	const exactMatches = phases.filter((phase) => phase.name === name);
	if (exactMatches.length === 1) return { hit: exactMatches[0], corrected: false };

	const normalizedName = normalized(name);
	const normalizedMatches = phases.filter((phase) => normalized(phase.name) === normalizedName);
	if (normalizedMatches.length === 1) return { hit: normalizedMatches[0], corrected: true };

	const suggestion = suggestionFor(phases, name, (phase) => phase.name);
	return suggestion ? { corrected: false, suggestion } : { corrected: false };
}
