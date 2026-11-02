/**
 * Validation is what lets a spec drive a widget unattended: every pattern compiles on the
 * linear-time engine, every field a block reads is fed by a rule, and the rules match the samples
 * the author saw. Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import {
	type CompiledLineMatcher,
	compilePatterns,
	type LineMatcher,
	MatcherCompileError,
	patternGroupNames,
} from "./matcher.ts";
import type { JobWidgetSampleLines } from "./source-types.ts";
import { checkStatedNumbers, dryRun } from "./spec-dry-run.ts";
import { parseSpec } from "./spec-parse.ts";
import { isRecord } from "./spec-parse-primitives.ts";
import { aggNeedsValue, fieldFeeds, ruleFields } from "./spec-rules.ts";
import { FIELD_NAME, type JobWidgetAgg, type JobWidgetSpec, type JobWidgetValueRef } from "./spec-types.ts";

export type JobWidgetSpecValidation = { ok: true; spec: JobWidgetSpec } | { ok: false; errors: string[] };

export interface JobWidgetValidateOptions {
	matcher: LineMatcher;
	/** Lines the author saw; enable the dry run. */
	samples?: readonly JobWidgetSampleLines[];
	/** The job's command, task and hints; with samples, a constant total or target must appear in one. */
	brief?: string;
}

/** Why an authored answer declines to draw a widget (its `skip`), or `undefined` for a spec. */
export function jobWidgetSkip(value: unknown): string | undefined {
	if (!isRecord(value) || typeof value.skip !== "string") return undefined;
	const reason = value.skip.trim();
	return reason.length > 0 ? reason : undefined;
}

export function validateJobWidgetSpec(value: unknown, options: JobWidgetValidateOptions): JobWidgetSpecValidation {
	const errors: string[] = [];
	const spec = parseSpec(value, errors);
	if (!spec) return { ok: false, errors };
	const numeric = checkReferences(spec, errors);
	let compiled: CompiledLineMatcher | undefined;
	try {
		compiled = compilePatterns(
			options.matcher,
			spec.rules.map((rule) => rule.match),
		);
	} catch (error) {
		if (!(error instanceof MatcherCompileError)) throw error;
		errors.push(`rules[${error.pattern}].match: ${error.reason}`);
	}
	if (compiled && options.samples && errors.length === 0) {
		dryRun(spec, compiled, options.samples, numeric, errors);
		if (options.brief !== undefined) checkStatedNumbers(spec, options.samples, options.brief, errors);
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, spec };
}

/** Checks rules and references; returns the fields read as numbers, each with the first place reading it. */
function checkReferences(spec: JobWidgetSpec, errors: string[]): Map<string, string> {
	const feeds = fieldFeeds(spec);
	const numeric = new Map<string, string>();
	const checkField = (where: string, field: string, agg: JobWidgetAgg | undefined, key?: string): void => {
		const feed = feeds.get(field);
		if (!feed) {
			errors.push(`${where}: unknown field "${field}"; no rule has a group (?P<${field}>…) or count "${field}"`);
			return;
		}
		if (key !== undefined && feed.keyGroups.has(key)) {
			errors.push(
				`${where}.key: "${key}" is the name of the key group; set one of its values (one model, one job) or omit \`key\``,
			);
		}
		if (agg === undefined || !aggNeedsValue(agg)) return;
		if (!feed.value) {
			errors.push(`${where}: agg "${agg}" needs numbers, but field "${field}" only counts matches or keeps text`);
		} else if (!numeric.has(field)) {
			numeric.set(field, where);
		}
	};
	const checkRef = (where: string, ref: JobWidgetValueRef): void => checkField(where, ref.field, ref.agg, ref.key);
	const needsKey = (where: string, field: string, kind: string): void => {
		if (feeds.get(field)?.keyGroups.size === 0) errors.push(`${where}: ${kind} need a rule with \`key\``);
	};
	spec.rules.forEach((rule, index) => {
		const where = `rules[${index}]`;
		if (rule.text !== undefined && rule.text === rule.key) errors.push(`${where}.text: the key group is not a field`);
		for (const group of patternGroupNames(rule.match)) {
			if (group !== rule.key && !FIELD_NAME.test(group)) {
				errors.push(`${where}.match: group "${group}" names a field, so it must match ${FIELD_NAME.source}`);
			}
		}
		if (ruleFields(rule).length === 0) {
			errors.push(`${where}: feeds no field; name a group (?P<field>…) besides the key, or set \`count\``);
		}
	});
	if (spec.headline) checkRef("headline", spec.headline);
	if (spec.stage) checkField("stage", spec.stage, undefined);
	spec.blocks.forEach((block, index) => {
		const where = `blocks[${index}] (${block.kind})`;
		switch (block.kind) {
			case "spark":
				checkField(where, block.field, "last", block.key);
				break;
			case "bars":
				checkField(where, block.field, block.agg);
				needsKey(where, block.field, "bars");
				break;
			case "meter":
				checkField(where, block.field, block.agg, block.key);
				if (typeof block.total !== "number") checkRef(`${where}.total`, block.total);
				break;
			case "stat":
				block.items.forEach((item, itemIndex) => checkRef(`${where}.items[${itemIndex}]`, item));
				break;
			case "grid":
				checkField(where, block.field, undefined);
				needsKey(where, block.field, "grids");
				break;
			case "text":
				checkField(where, block.field, undefined);
				break;
		}
	});
	return numeric;
}
