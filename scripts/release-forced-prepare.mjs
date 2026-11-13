#!/usr/bin/env node
/**
 * The `prepare` job of a release dispatched with `force_tests` (senpi#6642, `.github/workflows/publish-npm.yml`).
 *
 *   node scripts/release-forced-prepare.mjs --bundle <file> --github-output <file> [--sha <sha>] [--version <v>]
 *
 * It does what `release.mjs` did in-job before the suite ran: pin `--sha` if given, regenerate the model catalog,
 * check the bundled provider defaults against it, and commit a changed catalog on the release only. Then it hands the
 * result to the matrix jobs: `tested_sha` (that commit, or the dispatched one when nothing changed),
 * `base_sha` (the base resolved once, here; printed in full and used by every later job and `release.mjs --sha`), the
 * release `version` fixed now (a suite that crosses 00:00 UTC must not change it), and, only when a
 * catalog commit exists, a git bundle carrying it, since that commit is never pushed before the release tags it.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { computeNextVersion } from "./calver.mjs";
import { runGenerateModels, runProviderDefaultsCheck } from "./release-artifacts.mjs";
import { preparePinnedRelease } from "./release-pin.mjs";
import {
	catalogChangedSinceHead,
	catalogCommitMessage,
	changedCatalogPaths,
	discardTimestampOnlyCatalogChange,
} from "./release-test-gate.mjs";

/** The ref the bundle carries the tested commit under; the matrix jobs fetch it by this name. */
export const TESTED_COMMIT_REF = "refs/forced-suite/tested";

const VERSION_RE = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d+)?$/;

/**
 * Regenerate the catalog in `cwd` and commit it on top of HEAD when it changed.
 * @param {{cwd: string, version: string, regenerate: () => void, bundlePath: string, log: (line: string) => void}} input
 * @returns {{baseSha: string, testedSha: string, bundle: boolean}}
 */
export function prepareTestedCommit({ cwd, version, regenerate, bundlePath, log }) {
	const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	const baseSha = git("rev-parse", "HEAD");
	regenerate();
	if (discardTimestampOnlyCatalogChange(cwd)) {
		log("the regeneration changed only the catalog manifest's generatedAt stamp; keeping HEAD's catalog");
	}
	if (!catalogChangedSinceHead(cwd)) {
		log(`the regeneration changed nothing; the matrix jobs test the dispatched commit ${baseSha.slice(0, 12)}`);
		return { baseSha, testedSha: baseSha, bundle: false };
	}
	git("add", "-A", "--", ...changedCatalogPaths(cwd));
	git("commit", "-q", "-m", catalogCommitMessage(version));
	const testedSha = git("rev-parse", "HEAD");
	git("update-ref", TESTED_COMMIT_REF, testedSha);
	mkdirSync(dirname(bundlePath), { recursive: true });
	git("bundle", "create", "-q", bundlePath, TESTED_COMMIT_REF, `^${baseSha}`);
	log(`the regeneration changed the model catalog; the matrix jobs test the release-only commit ${testedSha.slice(0, 12)}`);
	return { baseSha, testedSha, bundle: true };
}

/** `$GITHUB_OUTPUT` lines for the prepare job's outputs. */
export function formatPrepareOutputs({ baseSha, testedSha, bundle }, version) {
	return `${[
		`base_sha=${baseSha}`,
		`tested_sha=${testedSha}`,
		`version=${version}`,
		`bundle=${bundle}`,
	].join("\n")}\n`;
}

const log = (line) => process.stdout.write(`[forced-prepare] ${line}\n`);
const dryRunLog = (line) => process.stdout.write(`[dry-run] ${line}\n`);

function runCommand(bin, args, extraEnv) {
	execFileSync(bin, args, { stdio: "inherit", env: extraEnv ? { ...process.env, ...extraEnv } : process.env });
}

function main() {
	const { values } = parseArgs({
		options: {
			sha: { type: "string" },
			version: { type: "string" },
			bundle: { type: "string" },
			"github-output": { type: "string" },
		},
	});
	if (!values.bundle || !values["github-output"]) throw new Error("--bundle and --github-output are required");
	if (values.version !== undefined && !VERSION_RE.test(values.version)) {
		throw new Error(`invalid --version ${JSON.stringify(values.version)} (expected YYYY.M.D or YYYY.M.D-N)`);
	}
	const capture = (bin, args) => execFileSync(bin, args, { encoding: "utf8" });
	if (values.sha) {
		preparePinnedRelease({
			sha: values.sha,
			dryRun: false,
			runCommand,
			capture,
			build: () => runCommand("npm", ["run", "build"]),
			driftPaths: ["packages/ai/src/models.generated.ts", "package-lock.json"],
			log,
			dryRunLog,
		});
	}
	const version = values.version ?? computeNextVersion();
	log(`release version: ${version}`);
	const result = prepareTestedCommit({
		cwd: process.cwd(),
		version,
		regenerate: () => {
			runGenerateModels(false, runCommand, log, dryRunLog);
			runProviderDefaultsCheck(false, runCommand, log, dryRunLog);
		},
		bundlePath: values.bundle,
		log,
	});
	// The base is resolved here, once: the matrix jobs and release.mjs --sha take this output and never look at main
	// again (release-train ruling on senpi#6642).
	if (!/^[0-9a-f]{40}$/.test(result.baseSha)) throw new Error(`resolved base ${JSON.stringify(result.baseSha)} is not a full sha`);
	log(`base commit for every later job: ${result.baseSha}`);
	appendFileSync(values["github-output"], formatPrepareOutputs(result, version));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`[forced-prepare] error: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
