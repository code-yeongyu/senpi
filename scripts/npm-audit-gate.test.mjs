import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateAudit, MAX_EXCEPTION_DAYS } from "./npm-audit-gate.mjs";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const advisory = (name, id, severity = "moderate") => ({ source: 1, name, title: `${id} title`, url: `https://github.com/advisories/${id}`, severity });
const report = {
	vulnerabilities: {
		forge: { name: "forge", severity: "moderate", via: [advisory("forge", "GHSA-aaaa"), advisory("forge", "GHSA-bbbb", "low")] },
		runtime: { name: "runtime", severity: "high", via: ["forge", "schema"] },
		schema: { name: "schema", severity: "high", via: [advisory("schema", "GHSA-cccc", "high")] },
		quiet: { name: "quiet", severity: "low", via: [advisory("quiet", "GHSA-dddd", "low")] },
	},
};
const exception = (advisoryId, pkg, expires = "2026-12-01") => ({ advisory: advisoryId, package: pkg, reason: "no fix published", issue: "#1", expires });
const all = [exception("GHSA-aaaa", "forge"), exception("GHSA-bbbb", "forge"), exception("GHSA-cccc", "schema")];

describe("npm-audit-gate", () => {
	it("passes when every advisory behind a moderate-or-above finding is excepted, including through via chains", () => {
		assert.deepEqual(evaluateAudit(report, all, NOW), []);
	});

	it("fails on a finding whose advisory is not excepted", () => {
		const failures = evaluateAudit(report, all.slice(0, 2), NOW);
		assert.ok(failures.some((f) => f.startsWith("schema (high): GHSA-cccc in schema")), failures.join("\n"));
		assert.ok(failures.some((f) => f.startsWith("runtime (high): GHSA-cccc in schema")), failures.join("\n"));
	});

	it("ignores findings below moderate", () => {
		assert.ok(!evaluateAudit(report, all, NOW).some((f) => f.includes("GHSA-dddd")));
	});

	it("fails an expired exception and does not let it cover its advisory", () => {
		const failures = evaluateAudit(report, [exception("GHSA-aaaa", "forge", "2026-11-10"), ...all.slice(1)], NOW);
		assert.ok(failures.some((f) => f.includes("expired on 2026-11-10")), failures.join("\n"));
		assert.ok(failures.some((f) => f.startsWith("forge (moderate): GHSA-aaaa in forge")), failures.join("\n"));
	});

	it(`fails an exception that expires more than ${MAX_EXCEPTION_DAYS} days out`, () => {
		const failures = evaluateAudit(report, [exception("GHSA-aaaa", "forge", "2027-01-31"), ...all.slice(1)], NOW);
		assert.ok(failures.some((f) => f.includes("more than 30 days out")), failures.join("\n"));
	});

	it("fails an exception that matches no current finding, so a fixed advisory leaves the list", () => {
		const failures = evaluateAudit(report, [...all, exception("GHSA-eeee", "gone")], NOW);
		assert.deepEqual(failures, ["exception GHSA-eeee (gone) matches no current finding; remove it"]);
	});

	it("does not let an exception for one package cover the same advisory id in another", () => {
		const failures = evaluateAudit(report, [exception("GHSA-aaaa", "other"), ...all.slice(1)], NOW);
		assert.ok(failures.some((f) => f.startsWith("forge (moderate): GHSA-aaaa in forge")), failures.join("\n"));
	});

	it("fails an exception missing its reason or tracking issue", () => {
		const failures = evaluateAudit(report, [{ ...all[0], issue: "" }, ...all.slice(1)], NOW);
		assert.ok(failures.some((f) => f.includes("missing issue")), failures.join("\n"));
	});
});
