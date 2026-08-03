#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CHANGELOGS = [
	"packages/ai/CHANGELOG.md",
	"packages/agent/CHANGELOG.md",
	"packages/coding-agent/CHANGELOG.md",
	"packages/tui/CHANGELOG.md",
];

const ENTRY_RE = /^\s*-\s+\S/m;

export function extractUnreleasedSection(text) {
	const start = text.match(/^## \[Unreleased\]\s*$/m);
	if (!start) return "";
	const from = (start.index ?? 0) + start[0].length;
	const rest = text.slice(from);
	const next = rest.search(/^## \[/m);
	return next === -1 ? rest : rest.slice(0, next);
}

export function hasUnreleasedEntries(text) {
	return ENTRY_RE.test(extractUnreleasedSection(text));
}

export function decideReleaseWorthiness(files, options = {}) {
	if (options.forceRelease) {
		return { releaseWorthy: true, reason: "forced" };
	}
	const changed = files.filter((file) => hasUnreleasedEntries(file.content));
	if (changed.length === 0) {
		return { releaseWorthy: false, reason: "no-unreleased-package-entries" };
	}
	return { releaseWorthy: true, reason: `unreleased-entries:${changed.map((file) => file.path).join(",")}` };
}

function parseArgs(argv) {
	const args = { forceRelease: false, selfTest: false, selfTestCase: "" };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--force-release") {
			args.forceRelease = true;
		} else if (arg === "--self-test") {
			args.selfTest = true;
		} else if (arg === "--case") {
			i += 1;
			args.selfTestCase = argv[i] ?? "";
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write("Usage: node scripts/upstream-release-worthy.mjs [--force-release] [--self-test]\n");
			process.exit(0);
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return args;
}

function runSelfTest(testCase) {
	const fixtures = [
		{ path: "packages/coding-agent/CHANGELOG.md", content: "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Fixed sync.\n" },
	];
	const docsOnly = [{ path: "packages/coding-agent/CHANGELOG.md", content: "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n" }];
	const cases = [
		["entry-release", decideReleaseWorthiness(fixtures), true],
		["force-release", decideReleaseWorthiness(docsOnly, { forceRelease: true }), true],
		["docs-only-skip", decideReleaseWorthiness(docsOnly), false],
		["empty-skip", decideReleaseWorthiness([]), false],
	];
	for (const [name, result, expected] of cases) {
		if (testCase && name !== testCase) continue;
		if (result.releaseWorthy !== expected) {
			throw new Error(`${name}: expected ${expected}, got ${result.releaseWorthy}`);
		}
		process.stdout.write(`${name}: release_worthy=${String(result.releaseWorthy)} reason=${result.reason}\n`);
	}
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.selfTest) {
		runSelfTest(args.selfTestCase);
		return;
	}
	const files = CHANGELOGS.map((path) => ({ path, content: readFileSync(path, "utf8") }));
	const result = decideReleaseWorthiness(files, { forceRelease: args.forceRelease });
	process.stdout.write(`release_worthy=${String(result.releaseWorthy)}\n`);
	process.stdout.write(`reason=${result.reason}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
