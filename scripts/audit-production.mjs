#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const EXCEPTED_URL = "https://github.com/advisories/GHSA-86w9-cpqp-85rv";
const EXPIRES_AT = Date.parse("2026-12-20T00:00:00Z");
// Installed call-site and input reachability assessment:
// https://github.com/code-yeongyu/senpi/issues/3886
// Only node-forge's specific advisory is excepted, never the package or its parents.

export function evaluateAudit(report, now = Date.now()) {
	const failures = new Set();
	if (!Number.isFinite(now) || now >= EXPIRES_AT) {
		failures.add("GHSA-86w9-cpqp-85rv exception expired; reassess reachability before renewing");
	}
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
	let excepted = false;
	function inspect(name, ancestors = new Set()) {
		const vulnerability = vulnerabilities[name];
		if (
			ancestors.has(name) ||
			!vulnerability ||
			vulnerability.name !== name ||
			!Array.isArray(vulnerability.via) ||
			vulnerability.via.length === 0
		) {
			throw new Error(`Invalid npm audit dependency chain: ${name}`);
		}
		const chain = new Set([...ancestors, name]);
		for (const advisory of vulnerability.via) {
			if (typeof advisory === "string") {
				inspect(advisory, chain);
			} else if (
				advisory &&
				typeof advisory.name === "string" &&
				typeof advisory.url === "string"
			) {
				if (name === "node-forge" && advisory.name === "node-forge" && advisory.url === EXCEPTED_URL) {
					excepted = true;
				} else {
					failures.add(`${name}: ${advisory.url}`);
				}
			} else {
				throw new Error(`Invalid npm audit advisory: ${name}`);
			}
		}
	}
	for (const name of Object.keys(vulnerabilities)) inspect(name);
	return {
		failures: [...failures],
		exception: excepted ? "GHSA-86w9-cpqp-85rv excepted until 2026-12-20T00:00:00Z" : "Exception stale: advisory absent",
	};
}

function main() {
	// npm is intentional: this workflow consumes npm's v2 advisory JSON schema.
	const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (audit.error || audit.signal || ![0, 1].includes(audit.status)) {
		throw new Error(`npm audit failed to run: ${audit.error?.message ?? audit.signal ?? audit.status}`);
	}
	const report = JSON.parse(audit.stdout);
	// Exit 1 with no findings is an operational failure, not an audit success.
	if (audit.status === 1 && Object.keys(report.vulnerabilities ?? {}).length === 0) {
		throw new Error("npm audit failed without vulnerability findings");
	}
	const result = evaluateAudit(report);
	console.log(result.exception);
	for (const failure of result.failures) console.error(failure);
	process.exitCode = result.failures.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
