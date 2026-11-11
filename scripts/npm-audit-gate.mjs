#!/usr/bin/env node
// Runs `npm audit --omit=dev` and fails on every finding at moderate or above unless each advisory behind it is
// listed in the reviewed exception file. An exception must name its advisory, package, reason and tracking issue, and
// expire within MAX_EXCEPTION_DAYS; an expired, over-long or unmatched exception fails the gate too, so the list can
// only shrink back to empty.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SEVERITY = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const THRESHOLD = SEVERITY.moderate;
export const MAX_EXCEPTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function advisoryId(advisory) {
	const id = String(advisory.url ?? "").split("/").pop();
	return id || `npm:${advisory.source}`;
}

/** Every advisory behind a finding: `via` holds advisories or the names of other vulnerable packages. */
export function leafAdvisories(vulnerabilities, name, seen = new Set()) {
	if (seen.has(name)) return [];
	seen.add(name);
	const leaves = [];
	for (const via of vulnerabilities[name]?.via ?? []) {
		if (typeof via === "string") leaves.push(...leafAdvisories(vulnerabilities, via, seen));
		else leaves.push({ id: advisoryId(via), package: via.name, title: via.title });
	}
	return leaves;
}

/** The end of a calendar date, or undefined for anything but a real YYYY-MM-DD day (Date.parse rolls 02-30 over). */
function strictDateEnd(value) {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
	const end = Date.parse(`${value}T23:59:59Z`);
	if (Number.isNaN(end) || new Date(end).toISOString().slice(0, 10) !== value) return undefined;
	return end;
}

function checkException(exception, now) {
	const problems = [];
	for (const field of ["advisory", "package", "reason", "issue", "expires"])
		if (typeof exception[field] !== "string" || exception[field].trim() === "") problems.push(`missing ${field}`);
	const expires = strictDateEnd(exception.expires);
	if (expires === undefined) problems.push(`expires is not a valid YYYY-MM-DD date: ${exception.expires}`);
	else if (expires < now) problems.push(`expired on ${exception.expires}`);
	else if (expires - now > MAX_EXCEPTION_DAYS * DAY_MS)
		problems.push(`expires ${exception.expires}, more than ${MAX_EXCEPTION_DAYS} days out`);
	return problems;
}

/** Returns the reasons the gate fails; an empty list passes. */
export function evaluateAudit(report, exceptions, now = Date.now()) {
	const failures = [];
	const active = [];
	for (const exception of exceptions) {
		const problems = checkException(exception, now);
		if (problems.length === 0) active.push(exception);
		else failures.push(`exception ${exception.advisory ?? "?"} (${exception.package ?? "?"}): ${problems.join("; ")}`);
	}
	const used = new Set();
	const vulnerabilities = report.vulnerabilities ?? {};
	for (const [name, finding] of Object.entries(vulnerabilities)) {
		if ((SEVERITY[finding.severity] ?? SEVERITY.critical) < THRESHOLD) continue;
		const leaves = leafAdvisories(vulnerabilities, name);
		if (leaves.length === 0) failures.push(`${name} (${finding.severity}): no advisory found behind the finding`);
		const uncovered = leaves.filter((leaf) => {
			const match = active.find((e) => e.advisory === leaf.id && e.package === leaf.package);
			if (match) used.add(match);
			return !match;
		});
		if (uncovered.length > 0)
			failures.push(`${name} (${finding.severity}): ${uncovered.map((l) => `${l.id} in ${l.package}`).join(", ")}`);
	}
	for (const exception of active)
		if (!used.has(exception))
			failures.push(`exception ${exception.advisory} (${exception.package}) matches no current finding; remove it`);
	return failures;
}

function main() {
	const exceptionsPath = process.argv[2] ?? ".github/npm-audit-exceptions.json";
	const exceptions = JSON.parse(readFileSync(exceptionsPath, "utf8")).exceptions;
	if (!Array.isArray(exceptions)) throw new Error(`${exceptionsPath}: "exceptions" must be an array`);
	const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (audit.error) throw audit.error;
	const report = JSON.parse(audit.stdout);
	if (report.error) throw new Error(`npm audit failed: ${JSON.stringify(report.error)}`);
	const failures = evaluateAudit(report, exceptions);
	const total = report.metadata?.vulnerabilities?.total ?? 0;
	if (failures.length > 0) {
		console.error(`npm-audit-gate: FAIL (${failures.length})`);
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log(`npm-audit-gate: PASS - ${total} finding(s), every one at moderate or above covered by ${exceptions.length} reviewed exception(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
