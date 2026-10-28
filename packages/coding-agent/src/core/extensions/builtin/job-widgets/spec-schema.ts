/**
 * JSON schema of {@link JobWidgetSpec}, carried by the forced `respond` tool the author model calls.
 * Deliberately bare (shapes and enums, no prose): the system prompt documents every property, and
 * the schema is billed as input on every request. Semantic checks live in `validateJobWidgetSpec`.
 * Nothing is required at the top: a `skip` answer declines to draw a widget.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import { JOB_WIDGET_AGGS } from "./spec-types.ts";
import { JOB_WIDGET_TONES } from "./view-types.ts";

const STRING = { type: "string" } as const;
const NUMBER = { type: "number" } as const;
const BETTER = { enum: ["higher", "lower"] } as const;
const VALUE_REF_SCHEMA = {
	type: "object",
	required: ["field", "agg"],
	properties: {
		field: STRING,
		agg: { enum: JOB_WIDGET_AGGS },
		label: STRING,
		key: STRING,
		unit: STRING,
		digits: { type: "integer" },
		better: BETTER,
	},
} as const;

export const JOB_WIDGET_SPEC_SCHEMA: Readonly<Record<string, unknown>> = {
	type: "object",
	properties: {
		skip: STRING,
		title: STRING,
		rules: {
			type: "array",
			items: {
				type: "object",
				required: ["from", "match"],
				properties: { from: STRING, match: STRING, key: STRING, text: STRING, count: STRING, scale: NUMBER },
			},
		},
		blocks: {
			type: "array",
			items: {
				type: "object",
				required: ["kind"],
				properties: {
					kind: { enum: ["spark", "bars", "meter", "stat", "grid", "text"] },
					field: STRING,
					label: STRING,
					key: STRING,
					// Optional on purpose: the validator reads an absent bars or meter `agg` as "last".
					agg: { enum: JOB_WIDGET_AGGS },
					unit: STRING,
					better: BETTER,
					target: NUMBER,
					targetLabel: STRING,
					min: NUMBER,
					max: NUMBER,
					total: { anyOf: [NUMBER, VALUE_REF_SCHEMA] },
					items: { type: "array", items: VALUE_REF_SCHEMA },
					tones: { type: "object", additionalProperties: { enum: JOB_WIDGET_TONES } },
				},
			},
		},
		headline: VALUE_REF_SCHEMA,
		stage: STRING,
	},
};
