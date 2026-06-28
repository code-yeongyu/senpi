#!/usr/bin/env node
/**
 * CalVer (Calendar Versioning) computation for the senpi monorepo.
 *
 * Version format: `YYYY.M.D` for the first release of the day, then
 * `YYYY.M.D-N` (N >= 2) for each subsequent same-day re-release.
 *
 * Same-day re-release contract:
 * - The very first publish on a given UTC date uses the bare `YYYY.M.D`.
 * - If that exact version already exists (published to npm OR tagged in git
 *   as `vYYYY.M.D`), the next release becomes `YYYY.M.D-2`.
 * - Subsequent same-day releases increment the suffix: `-2`, `-3`, ...
 *   The suffix is `max(existing N values) + 1`, where same-day `YYYY.M.D`
 *   (no suffix) is treated as N = 1 for the purposes of "next" computation.
 *
 * Tolerance:
 * - Registry/git failures (404, network, timeout, ENOTFOUND, etc.) are
 *   downgraded to stderr warnings; this module NEVER throws on a single
 *   source failure. A totally offline run still returns a valid CalVer.
 *
 * Programmatic use:
 *   import { computeNextVersion } from "./calver.mjs";
 *   const v = computeNextVersion();             // uses today + default pkg list
 *   const v2 = computeNextVersion({ date: "2026.5.13", packages: ["foo"] });
 *
 * CLI:
 *   node scripts/calver.mjs            -> next version (default)
 *   node scripts/calver.mjs --print    -> same as default
 *   node scripts/calver.mjs --json     -> JSON { version, today, existing[] }
 *   node scripts/calver.mjs --help     -> usage
 */

import { execFileSync } from "node:child_process";

const DEFAULT_PACKAGES = [
	"@code-yeongyu/senpi",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-orchestrator",
	"@earendil-works/pi-tui",
	"@earendil-works/pi-web-ui",
];

const REGISTRY_TIMEOUT_MS = 30000;

/**
 * Compute today's CalVer date stamp in `YYYY.M.D`.
 *
 * @param {Date} [now] Defaults to `new Date()`. Pass for tests.
 * @returns {string} e.g. `"2026.5.13"`.
 */
function computeToday(now = new Date()) {
	return `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.${now.getUTCDate()}`;
}

/**
 * Fetch published versions for a single npm package, tolerating any failure.
 *
 * @param {string} pkg npm package name (e.g. `"@code-yeongyu/senpi"`).
 * @returns {string[]} Array of versions, or `[]` on any failure.
 */
function fetchRegistryVersions(pkg) {
	try {
		const stdout = execFileSync("npm", ["view", pkg, "versions", "--json"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: REGISTRY_TIMEOUT_MS,
		});
		const trimmed = stdout.trim();
		if (!trimmed) {
			return [];
		}
		const parsed = JSON.parse(trimmed);
		if (Array.isArray(parsed)) {
			return parsed.filter((v) => typeof v === "string");
		}
		if (typeof parsed === "string") {
			return [parsed];
		}
		return [];
	} catch (err) {
		const message = err && typeof err === "object" && "message" in err ? err.message : String(err);
		process.stderr.write(`[calver] warn: failed to fetch versions for ${pkg}: ${message}\n`);
		return [];
	}
}

/**
 * Fetch git tags matching `v<today>*` and strip the leading `"v"`.
 * Returns an empty array on any failure (not a git repo, git missing, etc.).
 *
 * @param {string} today `YYYY.M.D` prefix.
 * @returns {string[]}
 */
function fetchGitTagVersions(today) {
	try {
		const stdout = execFileSync("git", ["tag", "--list", `v${today}*`], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: REGISTRY_TIMEOUT_MS,
		});
		return stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("v"))
			.map((line) => line.slice(1));
	} catch (err) {
		const message = err && typeof err === "object" && "message" in err ? err.message : String(err);
		process.stderr.write(`[calver] warn: failed to list git tags for v${today}*: ${message}\n`);
		return [];
	}
}

/**
 * Compute the next CalVer version.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.packages] Override default package list.
 * @param {string} [opts.date]       Override today (`YYYY.M.D`). For tests.
 * @returns {string} Next version, e.g. `"2026.5.13"` or `"2026.5.13-2"`.
 */
export function computeNextVersion(opts = {}) {
	const packages = Array.isArray(opts.packages) && opts.packages.length > 0 ? opts.packages : DEFAULT_PACKAGES;
	const today = typeof opts.date === "string" && opts.date.length > 0 ? opts.date : computeToday();

	const all = new Set();
	for (const pkg of packages) {
		for (const v of fetchRegistryVersions(pkg)) {
			all.add(v);
		}
	}
	for (const v of fetchGitTagVersions(today)) {
		all.add(v);
	}

	const prefix = `${today}-`;
	const sameDay = [...all].filter((v) => v === today || v.startsWith(prefix));
	if (sameDay.length === 0) {
		return today;
	}

	const suffixes = [];
	for (const v of sameDay) {
		if (v === today) {
			suffixes.push(1);
			continue;
		}
		const tail = v.slice(prefix.length);
		const n = Number(tail);
		if (Number.isFinite(n)) {
			suffixes.push(n);
		}
	}

	if (suffixes.length === 0) {
		return today;
	}

	return `${today}-${Math.max(...suffixes) + 1}`;
}

/**
 * Gather the same data exposed via `--json`. Internal helper for CLI use.
 *
 * @param {object} [opts] See {@link computeNextVersion}.
 * @returns {{ version: string, today: string, existing: string[] }}
 */
function gatherReport(opts = {}) {
	const packages = Array.isArray(opts.packages) && opts.packages.length > 0 ? opts.packages : DEFAULT_PACKAGES;
	const today = typeof opts.date === "string" && opts.date.length > 0 ? opts.date : computeToday();

	const all = new Set();
	for (const pkg of packages) {
		for (const v of fetchRegistryVersions(pkg)) {
			all.add(v);
		}
	}
	for (const v of fetchGitTagVersions(today)) {
		all.add(v);
	}

	const prefix = `${today}-`;
	const existing = [...all].filter((v) => v === today || v.startsWith(prefix)).sort();
	const version = computeNextVersion({ packages, date: today });
	return { version, today, existing };
}

function printHelp() {
	const text = [
		"Usage: node scripts/calver.mjs [--print | --json | --help]",
		"",
		"Computes the next CalVer version for the senpi monorepo.",
		"",
		"Options:",
		"  --print   Print next version to stdout (default).",
		"  --json    Print { version, today, existing[] } JSON.",
		"  --help    Show this help and exit.",
		"",
		"Version format:",
		"  YYYY.M.D            first release of the day",
		"  YYYY.M.D-N (N>=2)   subsequent same-day re-releases",
		"",
		"Registry / git failures are tolerated and emit stderr warnings;",
		"a completely offline run still returns a valid CalVer string.",
	].join("\n");
	process.stdout.write(`${text}\n`);
}

function isMainModule() {
	if (!process.argv[1]) {
		return false;
	}
	const entryUrl = new URL(`file://${process.argv[1]}`).href;
	return import.meta.url === entryUrl;
}

if (isMainModule()) {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		printHelp();
		process.exit(0);
	}

	if (args.includes("--json")) {
		const report = gatherReport();
		process.stdout.write(`${JSON.stringify(report)}\n`);
		process.exit(0);
	}

	// Default and --print are identical.
	const version = computeNextVersion();
	process.stdout.write(`${version}\n`);
	process.exit(0);
}
