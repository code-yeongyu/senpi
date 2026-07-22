import { invalidTranscriptReasons } from "./transcript-validation.mjs";

const NON_ALLOWLISTABLE_KINDS = new Set(["array-order", "audience", "frame-order", "invalid-record", "sequence"]);

export class StructuralParityError extends Error {
	name = "StructuralParityError";
}

/**
 * Compare normalized frames according to the structuralParity contract. Values
 * are deliberately not compared, except error codes and frame method/id pairing.
 * Frame count, direction, audience, notification ordering, object fields, and
 * JSON value types remain strict.
 */
export function compareStructuralTranscripts({ oracle, candidate }) {
	const differences = [];
	const maxLength = Math.max(oracle.length, candidate.length);
	const invalidBySide = [invalidTranscriptReasons(oracle), invalidTranscriptReasons(candidate)];
	for (let index = 0; index < maxLength; index += 1) {
		const oracleRecord = oracle[index];
		const candidateRecord = candidate[index];
		if (oracleRecord === undefined || candidateRecord === undefined) {
			differences.push(difference(index, "frame", "frame-order", oracleRecord, candidateRecord));
			continue;
		}
		const invalid = invalidBySide[0][index] ?? invalidBySide[1][index];
		if (invalid !== undefined) {
			differences.push(difference(index, "record", "invalid-record", oracleRecord, candidateRecord, invalid));
			continue;
		}
		if (oracleRecord.seq !== candidateRecord.seq) {
			differences.push(difference(index, "seq", "sequence", oracleRecord.seq, candidateRecord.seq));
			continue;
		}
		if (audienceKey(oracleRecord.target) !== audienceKey(candidateRecord.target)) {
			differences.push(difference(index, "target", "audience", oracleRecord.target, candidateRecord.target));
			continue;
		}
		if (oracleRecord.direction !== candidateRecord.direction || pairKey(oracleRecord.frame) !== pairKey(candidateRecord.frame)) {
			differences.push(difference(index, "frame", "frame-order", oracleRecord.frame, candidateRecord.frame));
			continue;
		}
		compareValue(oracleRecord.frame, candidateRecord.frame, "frame", index, differences);
	}
	return { differences, unclassified: differences };
}

/**
 * Intentional capability deltas retain the same non-negotiable ordering and
 * audience checks as structural parity. Payload differences are reported under
 * their owning documented gap rather than silently discarded.
 */
export function compareAllowlistedCapabilityDelta({ oracle, candidate, gapForMethod }) {
	const structural = compareStructuralTranscripts({ oracle, candidate });
	const differences = structural.differences.map((entry) => {
		if (NON_ALLOWLISTABLE_KINDS.has(entry.kind)) return entry;
		const method = methodAt(oracle, candidate, entry.index);
		const gap = method === undefined ? undefined : gapForMethod(method);
		if (gap === undefined) return entry;
		return {
			...entry,
			classification: "allowlisted-delta",
			rationale: gap.rationale,
			ruleId: gap.id,
		};
	});
	const maxLength = Math.max(oracle.length, candidate.length);
	for (let index = 0; index < maxLength; index += 1) {
		const oracleRecord = oracle[index];
		const candidateRecord = candidate[index];
		if (oracleRecord === undefined || candidateRecord === undefined) continue;
		if (structural.differences.some((entry) => entry.index === index && NON_ALLOWLISTABLE_KINDS.has(entry.kind))) {
			continue;
		}
		const method = methodAt(oracle, candidate, index);
		const gap = method === undefined ? undefined : gapForMethod(method);
		if (gap === undefined) continue;
		const values = [];
		compareValuesOnly(oracleRecord.frame, candidateRecord.frame, "frame", values);
		for (const value of values) {
			differences.push({
				index,
				...value,
				classification: "allowlisted-delta",
				rationale: gap.rationale,
				ruleId: gap.id,
			});
		}
	}
	return {
		differences,
		unclassified: differences.filter((entry) => entry.classification === undefined),
	};
}

export function assertNoStructuralDifferences(result) {
	if (result.differences.length === 0) return;
	const summary = result.differences.map((entry) => `${entry.index}:${entry.path}`).join(", ");
	throw new StructuralParityError(`Structural differential differences: ${summary}`);
}

function compareValue(oracle, candidate, path, index, differences) {
	if (Object.is(oracle, candidate)) return;
	if (Array.isArray(oracle) && Array.isArray(candidate)) {
		// Array values may vary for structural parity. Compare element type/shape
		// only when both sides supply a representative entry.
		if (oracle.length > 0 && candidate.length > 0) {
			compareValue(oracle[0], candidate[0], `${path}[0]`, index, differences);
		}
		return;
	}
	if (isObject(oracle) && isObject(candidate)) {
		const oracleKeys = Object.keys(oracle).sort();
		const candidateKeys = Object.keys(candidate).sort();
		if (!sameArray(oracleKeys, candidateKeys)) {
			differences.push(difference(index, path, "field-set", oracleKeys, candidateKeys));
			return;
		}
		for (const key of oracleKeys) {
			const nextPath = `${path}.${key}`;
			if (nextPath === "frame.error.code") {
				if (!Object.is(oracle[key], candidate[key])) {
					differences.push(difference(index, nextPath, "error-code", oracle[key], candidate[key]));
				}
				continue;
			}
			compareValue(oracle[key], candidate[key], nextPath, index, differences);
		}
		return;
	}
	if (typeof oracle !== typeof candidate || oracle === null || candidate === null) {
		differences.push(difference(index, path, "type", oracle, candidate));
	}
}

function compareValuesOnly(oracle, candidate, path, differences) {
	if (Object.is(oracle, candidate)) return;
	if (Array.isArray(oracle) && Array.isArray(candidate)) {
		const length = Math.min(oracle.length, candidate.length);
		for (let index = 0; index < length; index += 1) {
			compareValuesOnly(oracle[index], candidate[index], `${path}[${index}]`, differences);
		}
		return;
	}
	if (isObject(oracle) && isObject(candidate)) {
		for (const key of Object.keys(oracle)) {
			if (!Object.hasOwn(candidate, key)) continue;
			compareValuesOnly(oracle[key], candidate[key], `${path}.${key}`, differences);
		}
		return;
	}
	differences.push({ path, kind: "value", oracle, candidate });
}

function methodAt(oracle, candidate, index) {
	for (let position = index; position >= 0; position -= 1) {
		const oracleFrame = oracle[position]?.frame;
		const candidateFrame = candidate[position]?.frame;
		if (isObject(oracleFrame) && typeof oracleFrame.method === "string" && Object.hasOwn(oracleFrame, "id")) {
			if (isObject(candidateFrame) && candidateFrame.id === oracleFrame.id) return oracleFrame.method;
		}
		if (isObject(oracleFrame) && typeof oracleFrame.method === "string" && !Object.hasOwn(oracleFrame, "id")) {
			return oracleFrame.method;
		}
	}
	return undefined;
}

function difference(index, path, kind, oracle, candidate, rationale) {
	return {
		index,
		path,
		kind,
		oracle,
		candidate,
		classification: "parity-regression",
		rationale: rationale ?? "Frame sequence, audience, field shape, or error code differs.",
	};
}

function pairKey(frame) {
	if (!isObject(frame)) return `raw:${typeof frame}`;
	if (Object.hasOwn(frame, "id")) return `id:${JSON.stringify(frame.id)}`;
	return typeof frame.method === "string" ? `method:${frame.method}` : "object";
}

function audienceKey(target) {
	const separator = target.indexOf(":");
	return separator === -1 ? "default" : target.slice(separator + 1);
}

function sameArray(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
