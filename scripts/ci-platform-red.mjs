#!/usr/bin/env node

// Default-branch macOS/Windows results (senpi#6834). Pull requests run Linux only (ci-platform-scope.mjs), so a
// platform regression first fails on the push to main after its merge. `report` (run by platform-red.yml) files ONE
// tracking issue naming the merged PR when such a run fails, or comments on it while it is open; the release refuses
// while the latest settled main run of any of these workflows has a failed macOS/Windows job (release-ci-evidence.mjs).
// Reports run unserialised, so none is ever dropped: the issue is found by its label (a plain listing, not the lagging
// search index), and a report that loses a race to open it moves its details onto the oldest open one and closes its own.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The workflows with macOS/Windows legs, by file, with their `name:`, which `workflow_run` matches on. */
export const PLATFORM_WORKFLOWS = {
	"ci.yml": "CI",
	"native-prebuilds.yml": "Native Prebuilds",
	"read-summary-binary-parity.yml": "Read summary binary parity",
	"session-worker-compile.yml": "Compiled session worker",
};

export const PLATFORM_RED_TITLE = "Default-branch macOS/Windows CI is red";
export const PLATFORM_RED_LABEL = "platform-red";

const PLATFORM_RUNNER = /macos|windows/i;
// A cancelled or skipped run says nothing about main; the newest run that finished does.
const NOT_RUN = new Set(["cancelled", "skipped", "stale"]);

/** @param {Array<{name: string, labels?: string[], conclusion: string|null}>} jobs */
export function failedPlatformJobs(jobs) {
	return jobs.filter((job) => job.conclusion === "failure" && (job.labels ?? []).some((label) => PLATFORM_RUNNER.test(label)));
}

/**
 * @param {Array<{file: string, run?: {conclusion: string, html_url: string, head_sha: string, failedPlatformJobs: Array<{name: string}>}|null, error?: string}>} results
 * @returns {string[]} one line per workflow that blocks the release; a red run whose macOS/Windows jobs all passed
 *   is left to the "Check and test" gate
 */
export function releaseBlockers(results) {
	return results.flatMap(({ file, run, error }) => {
		if (error !== undefined) return [`${file}: could not read its latest main run (${error})`];
		if (!run || run.conclusion !== "failure" || run.failedPlatformJobs.length === 0) return [];
		const jobs = run.failedPlatformJobs.map((job) => job.name).join(", ");
		return [`${file}: ${jobs} failed on ${run.head_sha.slice(0, 12)} (${run.html_url})`];
	});
}

/**
 * @param {(args: string[]) => string} gh runs `gh` and returns its stdout
 * @param {string} path a workflow run's jobs endpoint
 */
function runJobs(gh, path) {
	return JSON.parse(gh(["api", path, "--paginate", "--slurp"])).flatMap((page) => page.jobs ?? []);
}

/**
 * The latest settled push run on main of every platform workflow, with its failed macOS/Windows jobs.
 * @param {(args: string[]) => string} gh
 */
export function latestPlatformResults(gh) {
	return Object.keys(PLATFORM_WORKFLOWS).map((file) => {
		try {
			const listed = JSON.parse(
				gh(["api", `repos/{owner}/{repo}/actions/workflows/${file}/runs?branch=main&event=push&status=completed&per_page=20`]),
			);
			const run = (listed.workflow_runs ?? []).find((candidate) => !NOT_RUN.has(candidate.conclusion ?? ""));
			if (!run) return { file, run: null };
			const failed = run.conclusion === "failure" ? failedPlatformJobs(runJobs(gh, `repos/{owner}/{repo}/actions/runs/${run.id}/jobs?per_page=100`)) : [];
			return { file, run: { ...run, failedPlatformJobs: failed } };
		} catch (error) {
			return { file, error: String(error.message).split("\n")[0] };
		}
	});
}

function requireEnv(env, name) {
	const value = env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

/** Files or updates the tracking issue for one failed default-branch run (platform-red.yml). */
function report(env, gh) {
	const repo = requireEnv(env, "GITHUB_REPOSITORY");
	const sha = requireEnv(env, "HEAD_SHA");
	const runPath = `repos/${repo}/actions/runs/${requireEnv(env, "RUN_ID")}/attempts/${requireEnv(env, "RUN_ATTEMPT")}/jobs?per_page=100`;
	const failed = failedPlatformJobs(runJobs(gh, runPath));
	if (failed.length === 0) {
		console.log("no macOS/Windows job failed in this run; nothing to report");
		return;
	}
	const prs = JSON.parse(gh(["api", `repos/${repo}/commits/${sha}/pulls`])).map((pr) => `#${pr.number}`);
	const body = [
		`A macOS/Windows job failed on the default branch. Pull requests run Linux only (senpi#6834), so this is where a platform regression first shows.`,
		"",
		`- Workflow: ${requireEnv(env, "WORKFLOW_NAME")}`,
		`- Run: ${requireEnv(env, "RUN_URL")}`,
		`- Commit: ${sha}`,
		`- Merged pull request: ${prs.length > 0 ? prs.join(", ") : "none (a direct push)"}`,
		"- Failed macOS/Windows jobs:",
		...failed.map((job) => `  - [${job.name}](${job.html_url})`),
		"",
		"The next release refuses while the latest main run of this workflow has a failed macOS/Windows job (`scripts/release-ci-evidence.mjs`). Fix it on main, then close this issue.",
	].join("\n");
	// Oldest first, so every concurrent report settles on the same issue.
	const openIssues = () =>
		JSON.parse(gh(["issue", "list", "--repo", repo, "--state", "open", "--label", PLATFORM_RED_LABEL, "--json", "number,title", "--limit", "100"]))
			.filter((issue) => issue.title === PLATFORM_RED_TITLE)
			.sort((a, b) => a.number - b.number);
	const comment = (number) => gh(["issue", "comment", String(number), "--repo", repo, "--body", body]);
	const [existing] = openIssues();
	if (existing) {
		comment(existing.number);
		console.log(`commented on #${existing.number}`);
		return;
	}
	gh(["label", "create", PLATFORM_RED_LABEL, "--repo", repo, "--force", "--color", "B60205", "--description", "A macOS/Windows job is red on the default branch (senpi#6834)"]);
	const created = Number(gh(["issue", "create", "--repo", repo, "--title", PLATFORM_RED_TITLE, "--label", PLATFORM_RED_LABEL, "--body", body]).trim().split("/").pop());
	const [oldest] = openIssues();
	if (oldest && oldest.number !== created) {
		comment(oldest.number);
		gh(["issue", "close", String(created), "--repo", repo, "--reason", "not planned", "--comment", `Duplicate of #${oldest.number}, opened by a report that ran at the same time.`]);
		console.log(`a concurrent report opened #${oldest.number} first; commented there and closed #${created}`);
		return;
	}
	console.log(`opened #${created}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const [command] = process.argv.slice(2);
	if (command !== "report") throw new Error(`usage: ci-platform-red.mjs report (got ${command})`);
	report(process.env, (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
}
