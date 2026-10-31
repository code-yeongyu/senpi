#!/usr/bin/env node

// Decides whether a CI run needs the full macOS/Windows job set (senpi#3957), and verifies the
// `Check and test` fan-in against that decision.
//
// Hosted macOS and Windows runners have little concurrency, so a pull request runs them only when its
// diff touches platform-specific paths. Every other event (a push to main after the merge, the merge
// queue, a manual dispatch) always runs the full set, and the `run-full-ci` label forces it on a PR.
// Anything this script cannot decide (no diff, a truncated file list) also runs the full set.

import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FULL_CI_LABEL = "run-full-ci";

// GitHub's pull request files API returns at most 3000 files; a list that long may be cut short.
export const PR_FILES_API_LIMIT = 3000;

// Jobs that run only on a macOS or Windows runner. Each is skipped when the run is not full, so the
// fan-in accepts `skipped` for exactly these jobs and only then.
export const PLATFORM_JOBS = [
	"macos-combined",
	"hooks-trust-storage-windows",
	"tui-mouse-windows",
	"tool-child-windows",
	"schedule-windows",
	"rpc-windows",
	"socket-secret-native-windows",
	"compiled-extensions-windows",
	"claude-executable-windows",
	"bash-grandchild-console-windows",
	"python-kernel-windows",
];

// Paths whose change can behave differently on macOS or Windows: native code and its loaders,
// packaging and binary builds, dependency locks, the CI workflows, and the scripts every
// macOS/Windows job runs through. General source (for example packages/coding-agent/src) is not here.
const platformPaths = [
	/^\.github\/workflows\//,
	/^\.github\/actions\//,
	/^scripts\/ci-platform-scope(\.test)?\.mjs$/,
	/^scripts\/(run-tests|test-temp-guard)\.mjs$/,
	/^crates\//,
	/^Cargo\.(toml|lock)$/,
	/^rust-toolchain(\.toml)?$/,
	/^packages\/pty\//,
	/^packages\/coding-agent\/native\//,
	/^packages\/coding-agent\/install-lock\//,
	// Named pipes, Job Objects and the supervisor live here under generic file names.
	/^packages\/coding-agent\/src\/modes\/rpc\//,
	/^(package\.json|package-lock\.json|npm-shrinkwrap\.json|bun\.lock|pnpm-lock\.yaml)$/,
	/^scripts\/(build-binaries|build-native-|copy-pty-native|prepare-bun-compile-assets|smoke-standalone-binary|compiled-extension-|devenv-setup|probe-native-|native-prebuild|session-worker-compile|generate-claude-agent-sdk-platform-lock|claude-sdk-platform-lock|rolldown-platform-lock)/,
	/^scripts\/qa\/read-summary-/,
];

// A file named for one platform is platform code wherever it lives (`windows-job.win32.test.ts`,
// `darwin/`, `devenv-setup.ps1`).
const platformName = /(^|[/._-])(win32|windows|darwin|macos|wsl|powershell)([/._-]|$)/i;
const platformExtension = /\.(ps1|cmd|bat)$/i;

/**
 * Files the macOS/Windows jobs of a workflow name in their steps (the suites and scripts they run). A change to one of
 * them changes what those jobs test, whatever its name, so it counts as platform-specific. The workflow is scanned as
 * text, job by job (two-space job keys under `jobs:`), because the scope job runs before any dependency is installed.
 * @param {string} workflowText
 * @returns {string[]} repository-relative suffixes such as `test/suite/hooks-trust.test.ts`
 */
export function platformJobFiles(workflowText) {
	const body = workflowText.split(/^jobs:\n/m)[1] ?? "";
	const jobs = body.split(/^(?=  [\w-]+:\n)/m).filter((job) => /\b(windows|macos)-latest\b/.test(job));
	const files = new Set();
	for (const job of jobs) {
		for (const [token] of job.matchAll(/[\w./-]+\.(?:test\.)?[cm]?[jt]sx?\b/g)) {
			const file = token.replace(/^(?:\.\.?\/)+/, "");
			if (file.includes("/") || file.includes(".test.")) files.add(file);
		}
	}
	return [...files].sort();
}

/**
 * @param {string} path
 * @param {readonly string[]} [jobFiles] platformJobFiles() of the workflows whose platform legs this run decides
 */
export function isPlatformPath(path, jobFiles = []) {
	return platformPaths.some((pattern) => pattern.test(path)) || platformName.test(path) || platformExtension.test(path)
		|| jobFiles.some((file) => path === file || path.endsWith(`/${file}`));
}

/**
 * @param {{ event: string, labels: string[], changedPaths: string[] | null, jobFiles?: readonly string[] }} input
 *   changedPaths is null when the diff could not be read.
 * @returns {{ full: boolean, reason: string }}
 */
export function classify({ event, labels, changedPaths, jobFiles = [] }) {
	if (event !== "pull_request") return { full: true, reason: `event ${event} always runs the full set` };
	if (labels.includes(FULL_CI_LABEL)) return { full: true, reason: `label ${FULL_CI_LABEL}` };
	if (changedPaths === null) return { full: true, reason: "changed files unavailable" };
	if (changedPaths.length === 0) return { full: true, reason: "empty changed-file list" };
	if (changedPaths.length >= PR_FILES_API_LIMIT) {
		return { full: true, reason: `${changedPaths.length} changed files may be truncated` };
	}
	const platform = changedPaths.filter((path) => isPlatformPath(path, jobFiles));
	if (platform.length > 0) {
		return { full: true, reason: `platform paths changed: ${platform.slice(0, 10).join(", ")}` };
	}
	return { full: false, reason: `${changedPaths.length} changed files, none platform-specific` };
}

/**
 * @param {Record<string, { result: string }>} needs  the fan-in job's `needs` context
 * @param {string} full  platform-scope's `full` output; anything but "false" counts as a full run
 * @returns {string[]} one error per job that blocks the gate
 */
export function verifyNeeds(needs, full) {
	const skippable = full === "false" ? new Set(PLATFORM_JOBS) : new Set();
	return Object.entries(needs)
		.filter(([name, { result }]) => result !== "success" && !(result === "skipped" && skippable.has(name)))
		.map(([name, { result }]) => `${name} finished with result '${result}'`);
}

function argument(argv, name) {
	const index = argv.indexOf(`--${name}`);
	if (index === -1 || index + 1 >= argv.length) throw new Error(`missing --${name}`);
	return argv[index + 1];
}

function readChangedPaths(file) {
	if (file === "") return null;
	return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
}

function main(argv) {
	const [command, ...rest] = argv;
	if (command === "classify") {
		// Outside a pull request the labels expression renders as null.
		const labels = JSON.parse(argument(rest, "labels")) ?? [];
		if (!Array.isArray(labels)) throw new Error("--labels must be a JSON array");
		const workflows = rest.flatMap((value, index) => (rest[index - 1] === "--workflow" ? [value] : []));
		const decision = classify({
			event: argument(rest, "event"),
			labels,
			changedPaths: readChangedPaths(argument(rest, "changed")),
			jobFiles: workflows.flatMap((file) => platformJobFiles(readFileSync(file, "utf8"))),
		});
		console.log(`full=${decision.full} (${decision.reason})`);
		if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `full=${decision.full}\n`);
		return 0;
	}
	if (command === "verify") {
		const needs = JSON.parse(process.env.NEEDS_JSON ?? "");
		const full = argument(rest, "full");
		for (const [name, { result }] of Object.entries(needs)) console.log(`${name}: ${result}`);
		const errors = verifyNeeds(needs, full);
		for (const error of errors) console.log(`::error::a required CI job ${error}`);
		return errors.length === 0 ? 0 : 1;
	}
	throw new Error(`unknown command: ${command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	process.exitCode = main(process.argv.slice(2));
}
