/**
 * The dry run of a parsed spec against the samples the author saw, and the check that constant
 * totals and targets are numbers the job states. Ported from oh-my-pi 9df0457b31 (MIT, Copyright
 * Can Boluk et al.).
 */
import { truncateText } from "./format.ts";
import type { CompiledLineMatcher } from "./matcher.ts";
import { type JobWidgetSampleLines, TOOL_CALL_MARK, TOOLS_SOURCE_ID } from "./source-types.ts";
import { ruleReadsSource } from "./spec-rules.ts";
import type { JobWidgetSpec } from "./spec-types.ts";
import { parseWidgetValue, statedNumbers } from "./value-parse.ts";

/**
 * Rejects rules matching none of the non-empty samples, a field read as a number whose captures
 * hold none, and rules reading the engine's tool-call marker lines. `compiled` holds one pattern
 * per rule, in spec order; `numeric` maps each field read as a number to where it is read.
 */
export function dryRun(
	spec: JobWidgetSpec,
	compiled: CompiledLineMatcher,
	samples: readonly JobWidgetSampleLines[],
	numeric: ReadonlyMap<string, string>,
	errors: string[],
): void {
	let seen = false;
	let matches = 0;
	const marked = new Set<number>();
	const numbers = new Set<string>();
	const words = new Map<string, string>();
	for (const sample of samples) {
		if (!sample.lines.some((line) => line.trim().length > 0)) continue;
		seen = true;
		for (const hit of compiled.matchLines(sample.lines)) {
			const rule = spec.rules[hit.pattern];
			if (!ruleReadsSource(rule.from, sample.id)) continue;
			matches += 1;
			const line = sample.lines[hit.line];
			if (sample.id === TOOLS_SOURCE_ID && line.startsWith(TOOL_CALL_MARK)) marked.add(hit.pattern);
			compiled.groupNames[hit.pattern].forEach((field, position) => {
				const span = hit.spans[position];
				if (field === rule.key || field === rule.text || span === undefined) return;
				const captured = line.slice(span.start, span.end);
				if (Number.isFinite(parseWidgetValue(captured))) numbers.add(field);
				else if (!words.has(field)) words.set(field, captured);
			});
		}
	}
	if (seen && matches === 0) {
		errors.push("no rule matches any sample line; copy the exact text of lines that carry the numbers");
	}
	for (const index of marked) {
		errors.push(
			`rules[${index}]: matches \`${TOOL_CALL_MARK}<tool> <intent>\` lines, which mark the subagent's tool calls, not its output; read the result lines below them, or skip if none show progress`,
		);
	}
	for (const [field, where] of numeric) {
		const word = words.get(field);
		if (word === undefined || numbers.has(field)) continue;
		errors.push(
			`${where}: field "${field}" needs numbers, but its group captured "${truncateText(word, 40)}" in the samples; capture only the digits`,
		);
	}
}

/** Rejects a constant meter total or spark target that neither `brief` nor the samples state. */
export function checkStatedNumbers(
	spec: JobWidgetSpec,
	samples: readonly JobWidgetSampleLines[],
	brief: string,
	errors: string[],
): void {
	const stated = statedNumbers([brief, ...samples.flatMap((sample) => sample.lines)]);
	spec.blocks.forEach((block, index) => {
		const where = `blocks[${index}] (${block.kind})`;
		if (block.kind === "meter" && typeof block.total === "number" && !stated.has(block.total)) {
			errors.push(
				`${where}.total: ${block.total} appears nowhere in the job or its output; read the total from a line (a value ref) or show the value as a stat`,
			);
		} else if (block.kind === "spark" && block.target !== undefined && !stated.has(block.target)) {
			errors.push(
				`${where}.target: ${block.target} appears nowhere in the job or its output; set a target only when the job states one`,
			);
		}
	});
}
