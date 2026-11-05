/**
 * Applies the rules reading one source to new lines and folds the captures into the field store.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import type { FieldStore } from "./field-state.ts";
import { type CompiledLineMatcher, compilePatterns, type LineMatcher } from "./matcher.ts";
import { ruleReadsSource } from "./spec-rules.ts";
import type { JobWidgetRule, JobWidgetSpec } from "./spec-types.ts";
import { parseWidgetValue } from "./value-parse.ts";

/** One rule with its pattern's named groups resolved to positions. */
interface CompiledRule {
	/** Position of the key group among the pattern's named groups; -1 without a key. */
	key: number;
	captures: { index: number; field: string; text: boolean }[];
	count: string | undefined;
	scale: number;
}

/** The rules reading one source, matched over their distinct patterns in one call per refresh. */
export interface SourceMatcher {
	compiled: CompiledLineMatcher;
	/** Per pattern, the rules using it, in spec order. */
	rules: CompiledRule[][];
}

function compileRule(rule: JobWidgetRule, groups: readonly string[]): CompiledRule {
	const captures: CompiledRule["captures"] = [];
	groups.forEach((field, index) => {
		if (field !== rule.key) captures.push({ index, field, text: field === rule.text });
	});
	return {
		key: rule.key === undefined ? -1 : groups.indexOf(rule.key),
		captures,
		count: rule.count,
		scale: rule.scale ?? 1,
	};
}

export function compileSourceMatcher(
	spec: JobWidgetSpec,
	matcher: LineMatcher,
	sourceId: string,
): SourceMatcher | undefined {
	// Rules sharing a pattern (one line read into several fields) run it once.
	const byPattern = new Map<string, JobWidgetRule[]>();
	for (const rule of spec.rules) {
		if (!ruleReadsSource(rule.from, sourceId)) continue;
		const rules = byPattern.get(rule.match);
		if (rules) rules.push(rule);
		else byPattern.set(rule.match, [rule]);
	}
	if (byPattern.size === 0) return undefined;
	const patterns = [...byPattern.keys()];
	const compiled = compilePatterns(matcher, patterns);
	return {
		compiled,
		rules: patterns.map((pattern, index) =>
			(byPattern.get(pattern) ?? []).map((rule) => compileRule(rule, compiled.groupNames[index])),
		),
	};
}

/** Matches `lines` and pushes every capture; returns the indexes of the lines some rule matched. */
export function applyMatches(
	entry: SourceMatcher,
	lines: readonly string[],
	t: number,
	store: FieldStore,
): Set<number> {
	const matched = new Set<number>();
	for (const hit of entry.compiled.matchLines(lines)) {
		matched.add(hit.line);
		const line = lines[hit.line];
		for (const rule of entry.rules[hit.pattern]) {
			const keySpan = rule.key < 0 ? undefined : hit.spans[rule.key];
			const key = keySpan ? line.slice(keySpan.start, keySpan.end).trim() : "";
			for (const capture of rule.captures) {
				const span = hit.spans[capture.index];
				if (!span) continue;
				const captured = line.slice(span.start, span.end);
				const value = capture.text ? Number.NaN : parseWidgetValue(captured) * rule.scale;
				// A capture holding no number is kept as text, so a status word still reaches grids.
				if (Number.isFinite(value)) store.push(capture.field, key, { value, text: undefined, line, t });
				else store.push(capture.field, key, { value: undefined, text: captured.trim(), line, t });
			}
			if (rule.count !== undefined) store.push(rule.count, key, { value: undefined, text: undefined, line, t });
		}
	}
	return matched;
}
