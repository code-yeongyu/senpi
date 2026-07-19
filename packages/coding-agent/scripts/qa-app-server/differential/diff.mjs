import { DIRECTIONS, invalidTranscriptReasons, sequenceDifference } from "./transcript-validation.mjs";

const CLASSIFICATIONS = new Set(["parity-regression", "known-gap", "allowlisted-delta", "harness-defect"]);
const NON_ALLOWLISTABLE_KINDS = new Set(["array-order", "audience", "frame-order", "invalid-record", "sequence"]);

export class AllowlistValidationError extends Error {
	name = "AllowlistValidationError";
}

export class UnclassifiedDifferenceError extends Error {
	name = "UnclassifiedDifferenceError";
}

export function parseAllowlist(value) {
	if (!isObject(value) || !Array.isArray(value.rules)) {
		throw new AllowlistValidationError("Differential allowlist must contain a rules array.");
	}
	const ids = new Set();
	const rules = value.rules.map((rule, index) => {
		if (!isObject(rule)) throw new AllowlistValidationError(`Allowlist rule ${index} must be an object.`);
		for (const field of ["id", "scenario", "classification", "path", "rationale"]) {
			if (typeof rule[field] !== "string" || rule[field].trim().length === 0) {
				throw new AllowlistValidationError(`Allowlist rule ${index} requires a nonempty ${field}.`);
			}
		}
		if (!CLASSIFICATIONS.has(rule.classification)) {
			throw new AllowlistValidationError(`Allowlist rule ${rule.id} has an unknown classification.`);
		}
		if (ids.has(rule.id)) throw new AllowlistValidationError(`Allowlist rule id is duplicated: ${rule.id}`);
		ids.add(rule.id);
		if (rule.direction !== undefined && !DIRECTIONS.has(rule.direction)) {
			throw new AllowlistValidationError(`Allowlist rule ${rule.id} has an invalid direction.`);
		}
		if (
			rule.responseId !== undefined &&
			rule.responseId !== null &&
			typeof rule.responseId !== "string" &&
			typeof rule.responseId !== "number"
		) {
			throw new AllowlistValidationError(`Allowlist rule ${rule.id} has an invalid responseId.`);
		}
		if (rule.kind !== undefined && (typeof rule.kind !== "string" || rule.kind.length === 0)) {
			throw new AllowlistValidationError(`Allowlist rule ${rule.id} has an invalid kind.`);
		}
		if (NON_ALLOWLISTABLE_KINDS.has(rule.kind)) {
			throw new AllowlistValidationError(`Allowlist rule ${rule.id} attempts to allowlist ${rule.kind}.`);
		}
		return Object.freeze({ ...rule, rationale: rule.rationale.trim() });
	});
	return Object.freeze({ rules: Object.freeze(rules) });
}

export function diffTranscripts({ scenario, oracle, candidate, allowlist }) {
	const differences = [];
	const matchedRuleIds = new Set();
	const maxLength = Math.max(oracle.length, candidate.length);
	const invalidBySide = [invalidTranscriptReasons(oracle), invalidTranscriptReasons(candidate)];
	for (let index = 0; index < maxLength; index++) {
		const oracleRecord = oracle[index];
		const candidateRecord = candidate[index];
		if (oracleRecord === undefined || candidateRecord === undefined) {
			differences.push(classified({
				index,
				path: "frame",
				kind: "frame-order",
				oracle: oracleRecord,
				candidate: candidateRecord,
				classification: "parity-regression",
				rationale: "Frame count or audience differs at this sequence position.",
			}));
			continue;
		}
		const invalid = invalidBySide[0][index] ?? invalidBySide[1][index];
		if (invalid !== undefined) {
			differences.push(classified({
				index,
				path: "record",
				kind: "invalid-record",
				oracle: oracleRecord,
				candidate: candidateRecord,
				classification: "harness-defect",
				rationale: invalid,
			}));
			continue;
		}
		if (oracleRecord.seq !== candidateRecord.seq) {
			differences.push(sequenceDifference(index, oracleRecord.seq, candidateRecord.seq));
			continue;
		}
		if (audienceKey(oracleRecord.target) !== audienceKey(candidateRecord.target)) {
			differences.push(classified({
				index,
				path: "target",
				kind: "audience",
				oracle: oracleRecord.target,
				candidate: candidateRecord.target,
				classification: "parity-regression",
				rationale: "Frame audience differs and audience is never allowlisted.",
			}));
			continue;
		}
		if (oracleRecord.direction !== candidateRecord.direction || pairKey(oracleRecord.frame) !== pairKey(candidateRecord.frame)) {
			differences.push(classified({
				index,
				path: "frame",
				kind: "frame-order",
				oracle: oracleRecord.frame,
				candidate: candidateRecord.frame,
				classification: "parity-regression",
				rationale: "Frame direction or request/notification pairing differs.",
			}));
			continue;
		}
		const recordDifferences = [];
		diffValue({ oracle: oracleRecord.frame, candidate: candidateRecord.frame, path: "frame", index, differences: recordDifferences });
		for (const difference of recordDifferences) {
			if (difference.kind === "array-order") {
				differences.push({
					...difference,
					classification: "parity-regression",
					rationale: "Array ordering differs and ordering is never allowlisted.",
				});
				continue;
			}
			const matching = allowlist.rules.filter((rule) =>
				matchesRule({ rule, scenario, oracleRecord, candidateRecord, difference }),
			);
			if (matching.length === 1) {
				const rule = matching[0];
				matchedRuleIds.add(rule.id);
				differences.push({
					...difference,
					classification: rule.classification,
					rationale: rule.rationale,
					ruleId: rule.id,
				});
				continue;
			}
			if (matching.length > 1) {
				for (const rule of matching) matchedRuleIds.add(rule.id);
				differences.push({
					...difference,
					classification: "harness-defect",
					rationale: `Allowlist rules overlap: ${matching.map((rule) => rule.id).join(", ")}`,
				});
				continue;
			}
			differences.push(difference);
		}
	}
	for (const rule of allowlist.rules) {
		if ((rule.scenario === "*" || rule.scenario === scenario) && !matchedRuleIds.has(rule.id)) {
			differences.push(classified({
				index: maxLength,
				path: `allowlist.${rule.id}`,
				kind: "stale-allowlist",
				oracle: null,
				candidate: null,
				classification: "harness-defect",
				rationale: `Allowlist rule did not match any difference for scenario ${scenario}.`,
			}));
		}
	}
	return {
		differences,
		unclassified: differences.filter((difference) => difference.classification === undefined),
	};
}

export function assertClassifiedDiff(result) {
	if (result.unclassified.length === 0) return;
	const summary = result.unclassified.map((difference) => `${difference.index}:${difference.path}`).join(", ");
	throw new UnclassifiedDifferenceError(`Unclassified differential transcript differences: ${summary}`);
}

function diffValue({ oracle, candidate, path, index, differences }) {
	if (Object.is(oracle, candidate)) return;
	if (Array.isArray(oracle) && Array.isArray(candidate)) {
		if (sameElementsDifferentOrder(oracle, candidate)) {
			differences.push({ index, path, kind: "array-order", oracle, candidate });
			return;
		}
		const length = Math.max(oracle.length, candidate.length);
		for (let itemIndex = 0; itemIndex < length; itemIndex++) {
			diffValue({
				oracle: oracle[itemIndex],
				candidate: candidate[itemIndex],
				path: `${path}[${itemIndex}]`,
				index,
				differences,
			});
		}
		return;
	}
	if (isObject(oracle) && isObject(candidate)) {
		const keys = [...new Set([...Object.keys(oracle), ...Object.keys(candidate)])].sort();
		for (const key of keys) {
			diffValue({ oracle: oracle[key], candidate: candidate[key], path: `${path}.${key}`, index, differences });
		}
		return;
	}
	differences.push({
		index,
		path,
		kind: oracle === undefined || candidate === undefined ? "missing-value" : "value",
		oracle,
		candidate,
	});
}

function matchesRule({ rule, scenario, oracleRecord, candidateRecord, difference }) {
	if (rule.scenario !== "*" && rule.scenario !== scenario) return false;
	if (rule.path !== difference.path) return false;
	if (rule.kind !== undefined && rule.kind !== difference.kind) return false;
	if (rule.direction !== undefined && rule.direction !== oracleRecord.direction) return false;
	if (rule.responseId !== undefined && rule.responseId !== responseId(oracleRecord.frame, candidateRecord.frame)) return false;
	return true;
}

function sameElementsDifferentOrder(oracle, candidate) {
	if (oracle.length !== candidate.length || oracle.length < 2) return false;
	const oracleValues = oracle.map(stableJson).sort();
	const candidateValues = candidate.map(stableJson).sort();
	return oracleValues.every((value, index) => value === candidateValues[index]);
}

function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}

function pairKey(frame) {
	if (!isObject(frame)) return `raw:${typeof frame}`;
	if (Object.hasOwn(frame, "id")) return `id:${stableJson(frame.id)}`;
	return typeof frame.method === "string" ? `method:${frame.method}` : "object";
}

function audienceKey(target) {
	const separator = target.indexOf(":");
	return separator === -1 ? "default" : target.slice(separator + 1);
}

function responseId(oracleFrame, candidateFrame) {
	if (isObject(oracleFrame) && Object.hasOwn(oracleFrame, "id")) return oracleFrame.id;
	if (isObject(candidateFrame) && Object.hasOwn(candidateFrame, "id")) return candidateFrame.id;
	return undefined;
}

function classified({ index, path, kind, oracle, candidate, classification, rationale }) {
	return { index, path, kind, oracle, candidate, classification, rationale };
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
