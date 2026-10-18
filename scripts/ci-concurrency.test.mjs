#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));

const EVENT_TEST = String.raw`github\.event_name\s*(==|!=)\s*'([a-z_]+)'`;
const CONTEXT = String.raw`github\.(ref|sha)`;

/**
 * Evaluate the expression shapes the CI concurrency block may use, for one event:
 * - `${{ github.event_name == '<event>' }}` (or `!=`), a boolean;
 * - `<prefix>${{ github.<ref|sha> }}` or `<prefix>${{ github.event_name == '<event>' && github.<ref|sha> || github.<ref|sha> }}`,
 *   a group name.
 * Anything else fails, so a new shape has to be taught here instead of being guessed at.
 * @param {unknown} value
 * @param {{event: string, ref: string, sha: string}} run
 */
function evaluate(value, run) {
	if (typeof value === "boolean") return value;
	const text = String(value);
	const eventTest = (operator, event) => (operator === "==" ? run.event === event : run.event !== event);
	const boolean = new RegExp(String.raw`^\$\{\{\s*${EVENT_TEST}\s*\}\}$`).exec(text);
	if (boolean) return eventTest(boolean[1], boolean[2]);
	const plain = new RegExp(String.raw`^([\w-]*)\$\{\{\s*${CONTEXT}\s*\}\}$`).exec(text);
	if (plain) return plain[1] + run[plain[2]];
	const ternary = new RegExp(String.raw`^([\w-]*)\$\{\{\s*${EVENT_TEST}\s*&&\s*${CONTEXT}\s*\|\|\s*${CONTEXT}\s*\}\}$`).exec(text);
	assert.ok(ternary, `unsupported concurrency expression: ${text}`);
	const [, prefix, operator, event, whenTrue, whenFalse] = ternary;
	return prefix + run[eventTest(operator, event) ? whenTrue : whenFalse];
}

const mainPush = (sha) => ({ event: "push", ref: "refs/heads/main", sha });
const pullRequest = (sha) => ({ event: "pull_request", ref: "refs/pull/7/merge", sha });

describe("CI concurrency (senpi#2960)", () => {
	it("gives each main commit its own run group, so a later merge never cancels, queues or replaces its run", () => {
		assert.deepEqual(workflow.on.push, { branches: ["main"] });
		const { group, "cancel-in-progress": cancel } = workflow.concurrency;
		assert.notEqual(evaluate(group, mainPush("c1")), evaluate(group, mainPush("c2")));
		assert.equal(evaluate(cancel, mainPush("c1")), false);
	});

	it("keeps one group per pull request, so a newer push or restack still cancels the superseded run", () => {
		assert.ok("pull_request" in workflow.on);
		const { group, "cancel-in-progress": cancel } = workflow.concurrency;
		assert.equal(evaluate(group, pullRequest("p1")), evaluate(group, pullRequest("p2")));
		assert.equal(evaluate(cancel, pullRequest("p1")), true);
	});
});
