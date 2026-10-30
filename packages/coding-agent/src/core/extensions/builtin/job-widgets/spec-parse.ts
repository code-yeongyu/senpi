/**
 * Structural parsing of an authored spec into {@link JobWidgetSpec}, with local repairs applied.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import { parseBlock } from "./spec-parse-block.ts";
import { parseValueRef } from "./spec-parse-ref.ts";
import { isRecord, readFieldName, readList, readNumber, readString } from "./spec-parse-primitives.ts";
import { repairRuleGroups } from "./spec-repair.ts";
import {
	GROUP_NAME,
	type JobWidgetBlockSpec,
	type JobWidgetHeadlineSpec,
	type JobWidgetRule,
	type JobWidgetSpec,
	MAX_BLOCKS,
	MAX_LABEL_CHARS,
	MAX_PATTERN_CHARS,
	MAX_RULES,
	MAX_TITLE_CHARS,
	SOURCE_ID,
} from "./spec-types.ts";

export function parseSpec(value: unknown, errors: string[]): JobWidgetSpec | undefined {
	if (!isRecord(value)) {
		errors.push("spec: expected an object");
		return undefined;
	}
	const title = readString(value.title, "title", errors, { cut: MAX_TITLE_CHARS, required: true });
	const rules = readList(value.rules, "rules", errors, 1, MAX_RULES)?.map((rule, index) =>
		parseRule(rule, `rules[${index}]`, errors),
	);
	const blocks = readList(value.blocks, "blocks", errors, 1, MAX_BLOCKS)?.map((block, index) =>
		parseBlock(block, `blocks[${index}]`, errors),
	);
	const headline = value.headline === undefined ? undefined : parseHeadline(value.headline, errors);
	const stage = value.stage === undefined ? undefined : readFieldName(value.stage, "stage", errors);
	if (errors.length > 0 || title === undefined || !rules || !blocks) return undefined;
	const presentRules = rules.filter((rule): rule is JobWidgetRule => rule !== undefined);
	const presentBlocks = blocks.filter((block): block is JobWidgetBlockSpec => block !== undefined);
	if (presentRules.length !== rules.length || presentBlocks.length !== blocks.length) return undefined;
	return {
		title,
		rules: presentRules,
		blocks: presentBlocks,
		...(headline ? { headline } : {}),
		...(stage ? { stage } : {}),
	};
}

function parseHeadline(value: unknown, errors: string[]): JobWidgetHeadlineSpec | undefined {
	const ref = parseValueRef(value, "headline", errors);
	const label = isRecord(value)
		? readString(value.label, "headline.label", errors, { cut: MAX_LABEL_CHARS })
		: undefined;
	if (!ref) return undefined;
	return label ? { ...ref, label } : ref;
}

function parseRule(value: unknown, where: string, errors: string[]): JobWidgetRule | undefined {
	if (!isRecord(value)) {
		errors.push(`${where}: expected an object`);
		return undefined;
	}
	const from = readString(value.from, `${where}.from`, errors, { required: true });
	if (from !== undefined && !SOURCE_ID.test(from)) errors.push(`${where}.from: invalid source id "${from}"`);
	const match = readString(value.match, `${where}.match`, errors, { required: true, max: MAX_PATTERN_CHARS });
	const group = (name: "key" | "text"): string | undefined => {
		const raw = readString(value[name], `${where}.${name}`, errors);
		if (raw !== undefined && !GROUP_NAME.test(raw)) errors.push(`${where}.${name}: invalid group name "${raw}"`);
		return raw;
	};
	const key = group("key");
	const text = group("text");
	const count = value.count === undefined ? undefined : readFieldName(value.count, `${where}.count`, errors);
	const scale = readNumber(value.scale, `${where}.scale`, errors);
	if (from === undefined || match === undefined) return undefined;
	return {
		from,
		...repairRuleGroups(match, key, text),
		...(count !== undefined ? { count } : {}),
		...(scale !== undefined ? { scale } : {}),
	};
}
