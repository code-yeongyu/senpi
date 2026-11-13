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
 * - Automatic computation is globally monotonic. If an explicit prior release
 *   used a later date than today, the next version increments that latest
 *   release's suffix instead of returning a lower calendar version.
 *
 * Tolerance:
 * - Unpublished packages (404) contribute an empty version baseline.
 * - Other registry/git failures (network, timeout, ENOTFOUND, etc.) are
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
 *   node scripts/calver.mjs --check <v> -> exit 1 unless <v> is canonical CalVer
 *   node scripts/calver.mjs --help     -> usage
 */

import { execFileSync } from "node:child_process";
import semver from "semver";

import { queryNpmRegistry } from "./npm-registry.mjs";
import { registryPackageNames } from "./registry-packages.mjs";

// Use the publish allowlist: source manifests may be private but rewritten for
// publication. Private-only workspaces (server, chord, sqlite) have no registry name.
const DEFAULT_PACKAGES = [...registryPackageNames.values()];

const REGISTRY_TIMEOUT_MS = 30000;
const CALVER_RE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d+))?$/;
const CANONICAL_CALVER_RE = /^\d{4}\.([1-9]\d?)\.([1-9]\d?)(?:-[1-9]\d*)?$/;

/** An explicit release version that npm would not publish byte for byte as given. */
export class CalVerInputError extends Error {
	/**
	 * @param {"CALVER_ZERO_PADDED" | "CALVER_NOT_CANONICAL"} code
	 * @param {unknown} input
	 * @param {string | undefined} canonical The form npm would publish, when it is canonical CalVer.
	 */
	constructor(code, input, canonical) {
		const hint = canonical ? `use ${canonical}` : "expected YYYY.M.D or YYYY.M.D-N with no leading zeros";
		super(`${code}: ${String(input)} -> ${hint}`);
		this.name = "CalVerInputError";
		this.code = code;
		this.input = input;
		this.canonical = canonical;
	}
}

function isCanonicalCalVer(version) {
	const match = CANONICAL_CALVER_RE.exec(version);
	// npm publishes semver's normalized form, so the tag and manifests match it only when that form is the input itself.
	return match !== null && Number(match[1]) <= 12 && Number(match[2]) <= 31 && semver.valid(version) === version;
}

/**
 * Return `version` when it is canonical CalVer (`YYYY.M.D` or `YYYY.M.D-N`, no leading zeros), else throw.
 * npm strips leading zeros, so `2026.11.02-1` shipped as `2026.11.2-1` beside a `v2026.11.02-1` tag (senpi#5406).
 *
 * @param {unknown} version
 * @returns {string}
 * @throws {CalVerInputError} `CALVER_ZERO_PADDED` for a leading zero, `CALVER_NOT_CANONICAL` for any other shape.
 */
export function assertCanonicalCalVer(version) {
	if (typeof version === "string" && isCanonicalCalVer(version)) {
		return version;
	}
	const text = String(version);
	const cleaned = semver.clean(text, { loose: true });
	const canonical = cleaned !== null && isCanonicalCalVer(cleaned) ? cleaned : undefined;
	const code = /(?:^|[.-])0\d/.test(text.trim()) ? "CALVER_ZERO_PADDED" : "CALVER_NOT_CANONICAL";
	throw new CalVerInputError(code, version, canonical);
}

/**
 * Compute today's CalVer date stamp in `YYYY.M.D`.
 *
 * @param {Date} [now] Defaults to `new Date()`. Pass for tests.
 * @returns {string} e.g. `"2026.5.13"`.
 */
export function computeToday(now = new Date()) {
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
		const stdout = queryNpmRegistry(pkg, "versions");
		const trimmed = stdout?.trim();
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
 * Fetch CalVer-shaped git tags and strip the leading `"v"`.
 * Returns an empty array on any failure (not a git repo, git missing, etc.).
 *
 * @returns {string[]}
 */
function fetchGitTagVersions() {
	try {
		const stdout = execFileSync("git", ["tag", "--list", "v[0-9]*"], {
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
		process.stderr.write(`[calver] warn: failed to list CalVer git tags: ${message}\n`);
		return [];
	}
}

function parseCalver(version) {
	const match = CALVER_RE.exec(version);
	if (!match) {
		return undefined;
	}
	return {
		version,
		year: Number(match[1]),
		month: Number(match[2]),
		day: Number(match[3]),
		suffix: Number(match[4] ?? 1),
	};
}

function compareCalver(left, right) {
	return (
		left.year - right.year ||
		left.month - right.month ||
		left.day - right.day ||
		left.suffix - right.suffix
	);
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
	for (const v of fetchGitTagVersions()) {
		all.add(v);
	}

	const prefix = `${today}-`;
	const sameDay = [...all].filter((v) => v === today || v.startsWith(prefix));
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

	const candidate = suffixes.length === 0 ? today : `${today}-${Math.max(...suffixes) + 1}`;
	const parsedCandidate = parseCalver(candidate);
	const latest = [...all]
		.map(parseCalver)
		.filter((version) => version !== undefined)
		.sort(compareCalver)
		.at(-1);

	if (!latest || compareCalver(parsedCandidate, latest) > 0) {
		return candidate;
	}

	return `${latest.year}.${latest.month}.${latest.day}-${latest.suffix + 1}`;
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
	for (const v of fetchGitTagVersions()) {
		all.add(v);
	}

	const prefix = `${today}-`;
	const existing = [...all].filter((v) => v === today || v.startsWith(prefix)).sort();
	const version = computeNextVersion({ packages, date: today });
	return { version, today, existing };
}

function printHelp() {
	const text = [
		"Usage: node scripts/calver.mjs [--print | --json | --check <version> | --help]",
		"",
		"Computes the next CalVer version for the senpi monorepo.",
		"",
		"Options:",
		"  --print   Print next version to stdout (default).",
		"  --json    Print { version, today, existing[] } JSON.",
		"  --check <version>  Exit 1 unless <version> is canonical CalVer (no leading zeros).",
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

	const checkIndex = args.indexOf("--check");
	if (checkIndex !== -1) {
		try {
			process.stdout.write(`${assertCanonicalCalVer(args[checkIndex + 1])}\n`);
			process.exit(0);
		} catch (err) {
			process.stderr.write(`[calver] error: ${err instanceof Error ? err.message : String(err)}\n`);
			process.exit(1);
		}
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
