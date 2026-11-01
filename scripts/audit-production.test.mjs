#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { evaluateAudit, parseExceptions } from "./audit-production.mjs";

const now = Date.parse("2026-11-01T00:00:00Z");
const ID = "GHSA-mrhx-c7xc-m3w5";
const advisory = (name, severity = "high", id = ID) => ({ name, severity, url: `https://github.com/advisories/${id}` });
const leaf = (name, nodes, via = [advisory(name)], effects = []) => ({ name, via, nodes, effects });
const report = (vulnerabilities = {}) => ({ auditReportVersion: 2, vulnerabilities });
const entry = (overrides = {}) => ({
	advisory: ID,
	package: "zod",
	node: "node_modules/@anthropic-ai/sandbox-runtime/node_modules/zod",
	reason: "no upstream fix; local operator config only",
	issue: "https://github.com/code-yeongyu/senpi/issues/4820",
	expires: "2026-12-20",
	...overrides,
});
const exceptions = (...entries) => parseExceptions({ exceptions: entries });
const SANDBOX_ZOD = "node_modules/@anthropic-ai/sandbox-runtime/node_modules/zod";

describe("shipped-dependency audit gate (#2941)", () => {
	it("ships an empty exceptions list", () => {
		const committed = JSON.parse(readFileSync(new URL("./audit-exceptions.json", import.meta.url), "utf8"));
		assert.deepEqual(parseExceptions(committed), []);
	});

	it("passes a clean audit and fails every unexcepted moderate-or-worse node with its path", () => {
		assert.deepEqual(evaluateAudit(report(), [], now), { failures: [], excepted: [], stale: [] });
		const result = evaluateAudit(
			report({
				zod: leaf("zod", ["node_modules/zod", SANDBOX_ZOD], [advisory("zod")], ["@modelcontextprotocol/sdk"]),
				"@modelcontextprotocol/sdk": leaf("@modelcontextprotocol/sdk", ["node_modules/@modelcontextprotocol/sdk"], ["zod"]),
			}),
			[],
			now,
		);
		assert.equal(result.failures.length, 2);
		assert.match(result.failures.join("\n"), new RegExp(`${ID} high zod at node_modules/zod \\(flagged dependents: @modelcontextprotocol/sdk\\)`));
	});

	it("waives one advisory on exactly one installed node, never its siblings, parents or other advisories", () => {
		const waived = exceptions(entry());
		const vulnerable = report({ zod: leaf("zod", ["node_modules/zod", SANDBOX_ZOD]) });
		const result = evaluateAudit(vulnerable, waived, now);
		assert.deepEqual(result.excepted, [`${ID} zod ${SANDBOX_ZOD}`]);
		assert.deepEqual(result.failures.map((failure) => failure.split(" at ")[1].split(":")[0]), ["node_modules/zod"]);
		const other = report({ zod: leaf("zod", [SANDBOX_ZOD], [advisory("zod", "high", "GHSA-2222-3333-4444")]) });
		assert.equal(evaluateAudit(other, waived, now).failures.length, 1);
		const renamed = report({ other: leaf("other", [SANDBOX_ZOD], [advisory("other")]) });
		assert.equal(evaluateAudit(renamed, waived, now).failures.length, 1);
	});

	it("fails an expired exception from its expiry date on and reports an unmatched one as stale", () => {
		const waived = exceptions(entry());
		const vulnerable = report({ zod: leaf("zod", [SANDBOX_ZOD]) });
		for (const time of ["2026-12-20T00:00:00Z", "2027-01-01T00:00:00Z"]) {
			assert.match(evaluateAudit(vulnerable, waived, Date.parse(time)).failures.join(), /exception expired 2026-12-20/);
		}
		const clean = evaluateAudit(report(), waived, now);
		assert.deepEqual(clean.failures, []);
		assert.deepEqual(clean.stale, [`${ID} zod ${SANDBOX_ZOD}`]);
	});

	it("ignores low and info advisories, like --audit-level=moderate", () => {
		for (const severity of ["low", "info"]) {
			const result = evaluateAudit(report({ zod: leaf("zod", [SANDBOX_ZOD], [advisory("zod", severity)]) }), [], now);
			assert.deepEqual(result.failures, []);
		}
		const moderate = report({ zod: leaf("zod", [SANDBOX_ZOD], [advisory("zod", "moderate")]) });
		assert.equal(evaluateAudit(moderate, [], now).failures.length, 1);
	});

	for (const [label, invalid] of [
		["null report", null],
		["v1 report", { auditReportVersion: 1, vulnerabilities: {} }],
		["registry error", { ...report(), error: { code: "E503" } }],
		["array vulnerabilities", report([])],
		["empty via", report({ zod: leaf("zod", [SANDBOX_ZOD], []) })],
		["missing parent", report({ zod: leaf("zod", [SANDBOX_ZOD], ["missing"]) })],
		["self cycle", report({ zod: leaf("zod", [SANDBOX_ZOD], ["zod"]) })],
		["null advisory", report({ zod: leaf("zod", [SANDBOX_ZOD], [null]) })],
		["no nodes", report({ zod: leaf("zod", []) })],
		["non-GHSA url", report({ zod: leaf("zod", [SANDBOX_ZOD], [{ ...advisory("zod"), url: "https://example.com" }]) })],
		["unknown severity", report({ zod: leaf("zod", [SANDBOX_ZOD], [advisory("zod", "severe")]) })],
	]) {
		it(`fails closed on malformed audit output: ${label}`, () => {
			assert.throws(() => evaluateAudit(invalid, [], now), /Invalid npm audit/);
		});
	}

	for (const [label, document] of [
		["missing list", {}],
		["extra field", { exceptions: [{ ...entry(), note: "x" }] }],
		["missing field", { exceptions: [{ ...entry(), reason: undefined }] }],
		["blank reason", { exceptions: [entry({ reason: " " })] }],
		["bad advisory id", { exceptions: [entry({ advisory: "CVE-2026-1" })] }],
		["foreign issue", { exceptions: [entry({ issue: "https://github.com/other/repo/issues/1" })] }],
		["bad date", { exceptions: [entry({ expires: "next year" })] }],
		["duplicate", { exceptions: [entry(), entry()] }],
	]) {
		it(`rejects an invalid exceptions list: ${label}`, () => {
			assert.throws(() => parseExceptions(document), /Invalid audit exception/);
		});
	}
});
