#!/usr/bin/env node
// Shipped-dependency audit gate (senpi#2941). Runs `npm audit --omit=dev` and fails closed on every
// moderate-or-worse advisory that is not covered by an unexpired entry in audit-exceptions.json.
// The scheduled npm-audit workflow and the release workflow both run this script, so they share one verdict.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXCEPTIONS_PATH = join(dirname(fileURLToPath(import.meta.url)), "audit-exceptions.json");
// Same threshold as the job's former `--audit-level=moderate`.
const FAILING_SEVERITIES = new Set(["moderate", "high", "critical"]);
const KNOWN_SEVERITIES = new Set(["info", "low", ...FAILING_SEVERITIES]);
const ADVISORY_URL = /^https:\/\/github\.com\/advisories\/(GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4})$/;
const ISSUE_URL = /^https:\/\/github\.com\/code-yeongyu\/senpi\/issues\/\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_KEYS = ["advisory", "package", "node", "reason", "issue", "expires"];

/**
 * Validates the committed exceptions list. Every entry waives one advisory on one installed node only,
 * never a package, a parent or another node of the same package.
 */
export function parseExceptions(document) {
	if (!document || typeof document !== "object" || !Array.isArray(document.exceptions)) {
		throw new Error("Invalid audit exceptions: expected { \"exceptions\": [...] }");
	}
	const seen = new Set();
	return document.exceptions.map((entry, index) => {
		const where = `audit exception #${index}`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid ${where}`);
		const keys = Object.keys(entry).sort();
		if (keys.join() !== [...ENTRY_KEYS].sort().join()) {
			throw new Error(`Invalid ${where}: fields must be exactly ${ENTRY_KEYS.join(", ")}`);
		}
		for (const key of ENTRY_KEYS) {
			if (typeof entry[key] !== "string" || entry[key].trim() === "") throw new Error(`Invalid ${where}: ${key}`);
		}
		if (!ADVISORY_URL.test(`https://github.com/advisories/${entry.advisory}`)) {
			throw new Error(`Invalid ${where}: advisory must be a GHSA id`);
		}
		if (!ISSUE_URL.test(entry.issue)) throw new Error(`Invalid ${where}: issue must be a senpi issue URL`);
		const expiresAt = Date.parse(`${entry.expires}T00:00:00Z`);
		if (!DATE.test(entry.expires) || !Number.isFinite(expiresAt)) {
			throw new Error(`Invalid ${where}: expires must be YYYY-MM-DD`);
		}
		const key = `${entry.advisory} ${entry.package} ${entry.node}`;
		if (seen.has(key)) throw new Error(`Invalid ${where}: duplicate ${key}`);
		seen.add(key);
		return { ...entry, key, expiresAt };
	});
}

/**
 * Evaluates an npm audit v2 report. Returns the failures (each names the advisory, package, installed node
 * and the parents it reaches through), the exceptions that matched, and the stale exceptions that no longer
 * match anything. Malformed input throws.
 */
export function evaluateAudit(report, exceptions, now = Date.now()) {
	if (!Number.isFinite(now)) throw new Error("Invalid audit clock");
	if (
		report?.auditReportVersion !== 2 ||
		report.error ||
		!report.vulnerabilities ||
		typeof report.vulnerabilities !== "object" ||
		Array.isArray(report.vulnerabilities)
	) {
		throw new Error("Invalid npm audit report or registry error");
	}
	const vulnerabilities = report.vulnerabilities;
	const failures = new Set();
	const used = new Set();
	const byKey = new Map(exceptions.map((entry) => [entry.key, entry]));

	function inspect(name, ancestors) {
		const vulnerability = vulnerabilities[name];
		if (
			ancestors.has(name) ||
			!vulnerability ||
			vulnerability.name !== name ||
			!Array.isArray(vulnerability.via) ||
			vulnerability.via.length === 0 ||
			!Array.isArray(vulnerability.nodes) ||
			vulnerability.nodes.length === 0 ||
			!vulnerability.nodes.every((node) => typeof node === "string" && node !== "")
		) {
			throw new Error(`Invalid npm audit dependency chain: ${name}`);
		}
		const chain = new Set([...ancestors, name]);
		for (const advisory of vulnerability.via) {
			if (typeof advisory === "string") {
				inspect(advisory, chain);
				continue;
			}
			const id = typeof advisory?.url === "string" ? ADVISORY_URL.exec(advisory.url)?.[1] : undefined;
			if (!id || advisory.name !== name || !KNOWN_SEVERITIES.has(advisory.severity)) {
				throw new Error(`Invalid npm audit advisory: ${name}`);
			}
			if (!FAILING_SEVERITIES.has(advisory.severity)) continue;
			const parents = Array.isArray(vulnerability.effects) && vulnerability.effects.length > 0
				? ` (flagged dependents: ${vulnerability.effects.join(", ")})`
				: "";
			for (const node of vulnerability.nodes) {
				const entry = byKey.get(`${id} ${name} ${node}`);
				if (!entry) {
					failures.add(`${id} ${advisory.severity} ${name} at ${node}${parents}: ${advisory.url}`);
				} else if (now >= entry.expiresAt) {
					used.add(entry.key);
					failures.add(`${id} ${name} at ${node}: exception expired ${entry.expires} (${entry.issue}); reassess before renewing`);
				} else {
					used.add(entry.key);
				}
			}
		}
	}

	for (const name of Object.keys(vulnerabilities)) inspect(name, new Set());
	return {
		failures: [...failures].sort(),
		excepted: exceptions.filter((entry) => used.has(entry.key) && now < entry.expiresAt).map((entry) => entry.key),
		stale: exceptions.filter((entry) => !used.has(entry.key)).map((entry) => entry.key),
	};
}

function main() {
	const exceptions = parseExceptions(JSON.parse(readFileSync(EXCEPTIONS_PATH, "utf8")));
	// npm is intentional: this gate consumes npm's v2 advisory JSON schema.
	const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (audit.error || audit.signal || ![0, 1].includes(audit.status)) {
		throw new Error(`npm audit failed to run: ${audit.error?.message ?? audit.signal ?? audit.status}`);
	}
	const report = JSON.parse(audit.stdout);
	// Exit 1 with no findings is an operational failure, not an audit success.
	if (audit.status === 1 && Object.keys(report.vulnerabilities ?? {}).length === 0) {
		throw new Error("npm audit failed without vulnerability findings");
	}
	const result = evaluateAudit(report, exceptions);
	for (const key of result.excepted) console.log(`excepted: ${key}`);
	for (const key of result.stale) console.log(`stale exception (advisory no longer reported): ${key}`);
	for (const failure of result.failures) console.error(failure);
	console.log(`${result.failures.length} unexcepted moderate-or-worse advisory finding(s)`);
	process.exitCode = result.failures.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
