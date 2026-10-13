#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const required = JSON.parse(readFileSync(new URL("../.github/required-checks.json", import.meta.url), "utf8"));

function workflow(file) {
	return parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));
}

describe("merge queue: every required check also runs on merge_group", () => {
	it("lists the required checks", () => {
		assert.ok(required.checks.length > 0);
	});

	for (const check of required.checks) {
		describe(check.context, () => {
			const parsed = workflow(check.workflow);
			const job = parsed.jobs?.[check.job];

			it(`${check.workflow} triggers on merge_group checks_requested`, () => {
				assert.ok(parsed.on && typeof parsed.on === "object" && "merge_group" in parsed.on, `${check.workflow} has no merge_group trigger`);
				assert.deepEqual(parsed.on.merge_group, { types: ["checks_requested"] });
			});

			it(`job ${check.job} reports under the exact required name`, () => {
				assert.ok(job, `${check.workflow} has no job ${check.job}`);
				assert.equal(job.name, check.context);
			});

			it("is the only job in its workflow that reports under that name", () => {
				const named = Object.entries(parsed.jobs).filter(([, other]) => other.name === check.context);
				assert.deepEqual(named.map(([id]) => id), [check.job]);
			});

			it("is not skipped on merge_group by an event filter", () => {
				const condition = String(job?.if ?? "");
				if (!/github\.event_name/.test(condition)) return;
				assert.match(condition, /github\.event_name == 'merge_group'/, `${check.job} filters events but omits merge_group, so the queue would see it skipped`);
			});
		});
	}
});

describe("Changelog gate on merge_group", () => {
	const job = workflow("changelog-gate.yml").jobs["changelog-gate"];
	const step = (name) => job.steps.find((candidate) => candidate.name === name);

	it("checks out the queue commit when there is no pull request", () => {
		assert.equal(step("Checkout").with.ref, "${{ github.event.pull_request.head.sha || github.sha }}");
	});

	it("runs the PR-metadata check only for pull requests", () => {
		assert.equal(step("Check PR changelog and changes.md coverage").if, "github.event_name == 'pull_request'");
	});

	it("still runs the whole-tree changes.md audit on the queue commit", () => {
		assert.equal(step("Audit changes.md coverage against the upstream pin").if, undefined);
	});
});

describe("Review claim gate on merge_group", () => {
	const gate = workflow("review-claims.yml").jobs.gate;
	const script = gate.steps[0].with.script;
	const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

	/** Runs the workflow's own script with stubbed github-script inputs and returns what it reported. */
	async function runGate(payload, labels) {
		const requested = [];
		const result = { failed: undefined, info: undefined };
		const github = {
			rest: { issues: { listLabelsOnIssue: Symbol("listLabelsOnIssue") } },
			paginate: async (_method, options) => {
				requested.push(options.issue_number);
				return labels.map((name) => ({ name }));
			},
		};
		const core = {
			setFailed: (message) => {
				result.failed = message;
			},
			info: (message) => {
				result.info = message;
			},
		};
		const context = { repo: { owner: "o", repo: "r" }, payload };
		await new AsyncFunction("github", "context", "core", script)(github, context, core);
		return { ...result, requested };
	}

	const queued = (headRef) => ({ merge_group: { head_ref: headRef } });

	it("reads the queued pull request's labels from the merge group head ref", async () => {
		const run = await runGate(queued("refs/heads/gh-readonly-queue/main/pr-3169-b07fa24074c8fe7317ebec4a2ef1ba74272aab49"), []);
		assert.deepEqual(run.requested, [3169]);
		assert.equal(run.failed, undefined);
	});

	it("handles a base branch containing a slash", async () => {
		const run = await runGate(queued("refs/heads/gh-readonly-queue/release/v1/pr-12-0123abcd"), []);
		assert.deepEqual(run.requested, [12]);
	});

	it("blocks a queued pull request that carries a claim label", async () => {
		const run = await runGate(queued("refs/heads/gh-readonly-queue/main/pr-7-abc123"), ["will-review"]);
		assert.match(run.failed ?? "", /will-review/);
	});

	for (const headRef of ["", "refs/heads/main", "refs/heads/gh-readonly-queue/main/pr-7-not-hex"]) {
		it(`fails closed without reading labels when the head ref is ${JSON.stringify(headRef)}`, async () => {
			const run = await runGate(queued(headRef), []);
			assert.ok(run.failed, "the gate must fail when it cannot identify the pull request");
			assert.deepEqual(run.requested, []);
		});
	}

	it("still uses the pull request payload on pull request events", async () => {
		const run = await runGate({ pull_request: { number: 41 } }, []);
		assert.deepEqual(run.requested, [41]);
	});

	it("runs with a read-only token", () => {
		assert.deepEqual(gate.permissions, { issues: "read", "pull-requests": "read" });
	});
});
