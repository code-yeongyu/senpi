import type { JsonValue, TranscriptDirection, TranscriptRecord } from "./normalize.mjs";

export type DifferenceClassification =
	| "parity-regression"
	| "known-gap"
	| "allowlisted-delta"
	| "harness-defect";

export type AllowlistRule = {
	readonly id: string;
	readonly scenario: string;
	readonly classification: DifferenceClassification;
	readonly path: string;
	readonly rationale: string;
	readonly direction?: TranscriptDirection;
	readonly responseId?: string | number | null;
	readonly kind?: string;
};

export type ParsedAllowlist = { readonly rules: readonly AllowlistRule[] };

export type TranscriptDifference = {
	readonly index: number;
	readonly path: string;
	readonly kind: string;
	readonly oracle: JsonValue | undefined;
	readonly candidate: JsonValue | undefined;
	readonly classification?: DifferenceClassification;
	readonly rationale?: string;
	readonly ruleId?: string;
};

export type DiffResult = {
	readonly differences: readonly TranscriptDifference[];
	readonly unclassified: readonly TranscriptDifference[];
};

export class AllowlistValidationError extends Error {}
export class UnclassifiedDifferenceError extends Error {}

export function parseAllowlist(value: unknown): ParsedAllowlist;
export function diffTranscripts(input: {
	readonly scenario: string;
	readonly oracle: readonly TranscriptRecord[];
	readonly candidate: readonly TranscriptRecord[];
	readonly allowlist: ParsedAllowlist;
}): DiffResult;
export function assertClassifiedDiff(result: DiffResult): void;
