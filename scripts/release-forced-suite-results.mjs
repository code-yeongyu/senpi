/**
 * The forced-suite matrix jobs' result files (senpi#6642). Each job (`forced-rest`, and `forced-shard` 1..N in
 * `.github/workflows/publish-npm.yml`) writes one through `release-forced-test-part.mjs`, and the release job hands
 * them all to `release.mjs --tested-sha`. That is the second gate behind the job's `needs` condition: the release
 * refuses to stamp unless every part reported a pass, with tests, for the very commit it is about to tag.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORCED_SHARD_JOBS } from "./release-forced-test-suite.mjs";

/** @typedef {{id: string, part: "rest"|"coding-agent", shard: number|null, of: number|null}} ForcedSuitePart */

/** @type {ForcedSuitePart[]} */
export const FORCED_SUITE_PARTS = [
	{ id: "rest", part: "rest", shard: null, of: null },
	...Array.from({ length: FORCED_SHARD_JOBS }, (_, index) => ({
		id: `coding-agent-${index + 1}`,
		part: /** @type {const} */ ("coding-agent"),
		shard: index + 1,
		of: FORCED_SHARD_JOBS,
	})),
];

export const forcedSuiteResultFile = (id) => `forced-suite-result-${id}.json`;

/**
 * @param {string} dir
 * @param {{testedSha: string, part: ForcedSuitePart, exitCode: number, files: number, tests: number}} result
 */
export function writeForcedSuiteResult(dir, { testedSha, part, exitCode, files, tests }) {
	const body = { tested_sha: testedSha, part: part.part, shard: part.shard, of: part.of, exit: exitCode, files, tests };
	writeFileSync(join(dir, forcedSuiteResultFile(part.id)), `${JSON.stringify(body)}\n`);
}

function readResult(dir, part) {
	const file = join(dir, forcedSuiteResultFile(part.id));
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`no readable forced-suite result for ${part.id} (${file}): ${error instanceof Error ? error.message : error}`, {
			cause: error,
		});
	}
}

/**
 * Refuse unless every part's result file is present, names this part, passed with at least one test, and tested
 * `testedSha`.
 * @param {{dir: string, testedSha: string}} input
 * @returns {ForcedSuitePart[]} the accepted parts
 */
export function assertForcedSuiteResults({ dir, testedSha }) {
	for (const part of FORCED_SUITE_PARTS) {
		const result = readResult(dir, part);
		if (result.part !== part.part || result.shard !== part.shard || result.of !== part.of) {
			throw new Error(
				`the ${part.id} result file reports ${result.part} shard ${result.shard} of ${result.of}; expected ${part.part} shard ${part.shard} of ${part.of}`,
			);
		}
		if (result.tested_sha !== testedSha) {
			throw new Error(
				`${part.id} tested ${String(result.tested_sha).slice(0, 12)}, not the released commit ${testedSha.slice(0, 12)}`,
			);
		}
		if (result.exit !== 0) throw new Error(`${part.id} did not pass (exit ${result.exit})`);
		if (!Number.isInteger(result.files) || !Number.isInteger(result.tests) || result.tests <= 0) {
			throw new Error(`${part.id} reports no tests (files ${result.files}, tests ${result.tests})`);
		}
	}
	return FORCED_SUITE_PARTS;
}
