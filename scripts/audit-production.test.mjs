#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateAudit } from "./audit-production.mjs";

const active = Date.parse("2026-10-21T00:00:00Z");
const url = "https://github.com/advisories/GHSA-86w9-cpqp-85rv";
const finding = (name, advisoryUrl = url) => ({ name, via: [{ name, url: advisoryUrl }] });
const report = (vulnerabilities = {}) => ({ auditReportVersion: 2, vulnerabilities });

// #3886: the audit must waive one advisory, not its package or transitive parents.
describe("production audit exception", () => {
	it("accepts the exact advisory and its transitive audit entries before expiry", () => {
		const result = evaluateAudit(report({
			"node-forge": finding("node-forge"),
			"@anthropic-ai/sandbox-runtime": { name: "@anthropic-ai/sandbox-runtime", via: ["node-forge"] },
			"@earendil-works/gondolin": { name: "@earendil-works/gondolin", via: ["node-forge"] },
		}), active);
		assert.deepEqual(result.failures, []);
		assert.match(result.exception, /excepted until/);
	});

	for (const time of ["2026-12-20T00:00:00Z", "2026-12-21T00:00:00Z"]) {
		it(`fails an expired exception at ${time}, even with a clean audit`, () => {
			for (const findings of [{}, { "node-forge": finding("node-forge") }]) {
				assert.match(evaluateAudit(report(findings), Date.parse(time)).failures.join(), /expired/);
			}
		});
	}

	for (const [name, findings] of [
		["another advisory on node-forge", { "node-forge": finding("node-forge", "https://github.com/advisories/GHSA-other") }],
		["same advisory URL on another package", { other: finding("other") }],
		["mixed advisories", {
			"node-forge": finding("node-forge"),
			other: finding("other", "https://github.com/advisories/GHSA-other"),
		}],
		["independent advisory on a transitive parent", {
			"node-forge": finding("node-forge"),
			parent: { name: "parent", via: ["node-forge", { name: "parent", url: "https://github.com/advisories/GHSA-other" }] },
		}],
	]) {
		it(`fails ${name}`, () => {
			assert.equal(evaluateAudit(report(findings), active).failures.length, 1);
		});
	}

	it("reports a stale exception without hiding a clean audit", () => {
		const result = evaluateAudit(report(), active);
		assert.deepEqual(result.failures, []);
		assert.match(result.exception, /stale/);
	});

	for (const invalid of [
		null,
		{},
		{ auditReportVersion: 1, vulnerabilities: {} },
		{ ...report(), error: { code: "E503" } },
		report([]),
		report({ broken: { name: "broken", via: [] } }),
		report({ broken: { name: "broken", via: ["missing"] } }),
		report({ broken: { name: "broken", via: ["broken"] } }),
		report({ broken: { name: "broken", via: [null] } }),
	]) {
		it("fails closed on malformed audit output or dependency chains", () => {
			assert.throws(() => evaluateAudit(invalid, active), /Invalid npm audit/);
		});
	}
});
