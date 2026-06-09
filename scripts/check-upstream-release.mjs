#!/usr/bin/env node
/**
 * Detect whether badlogic/pi-mono (upstream) has a release that is not yet merged into the
 * current branch. Used as the gate for .github/workflows/upstream-agent-merge.yml.
 *
 * Resolution:
 *   1. Find the latest upstream release tag (GitHub Releases, falling back to the highest
 *      semver `v*` tag on the upstream remote).
 *   2. Resolve that tag to its commit sha and fetch it.
 *   3. If that commit is already an ancestor of HEAD, the release is merged -> no work.
 *      Otherwise -> proceed.
 *
 * Output: human-readable log on stderr; `key=value` lines appended to $GITHUB_OUTPUT when set
 * (proceed, tag, sha, current_tag). Also prints the same pairs to stdout for local runs.
 *
 * Flags:
 *   --force   Always report proceed=true (manual re-run / recovery).
 *   --help    Show usage.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const UPSTREAM_REMOTE = "upstream";
const UPSTREAM_REPO = "badlogic/pi-mono";
const PIN_PATH = ".github/upstream.json";

function log(message) {
	process.stderr.write(`[check-upstream] ${message}\n`);
}

function run(bin, args) {
	return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryRun(bin, args) {
	try {
		return { ok: true, stdout: run(bin, args) };
	} catch (error) {
		return { ok: false, stdout: error.stdout?.toString().trim() ?? "", code: error.status };
	}
}

function hasGh() {
	return tryRun("gh", ["--version"]).ok;
}

function latestUpstreamReleaseTag() {
	if (hasGh()) {
		const release = tryRun("gh", ["api", `repos/${UPSTREAM_REPO}/releases/latest`, "--jq", ".tag_name"]);
		if (release.ok && release.stdout) {
			return release.stdout;
		}
		log("gh releases/latest unavailable; falling back to remote tags");
	}

	const lsRemote = run("git", ["ls-remote", "--tags", "--refs", UPSTREAM_REMOTE, "v*"]);
	const tags = lsRemote
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t")[1]?.replace("refs/tags/", ""))
		.filter((tag) => tag && /^v\d+\.\d+\.\d+$/.test(tag));
	if (tags.length === 0) {
		throw new Error("no upstream v* tags found");
	}
	tags.sort((a, b) => compareSemver(b.slice(1), a.slice(1)));
	return tags[0];
}

function compareSemver(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) {
			return (pa[i] ?? 0) - (pb[i] ?? 0);
		}
	}
	return 0;
}

function resolveTagSha(tag) {
	// Fetch the tag so the commit object exists locally for the ancestry check.
	const fetch = tryRun("git", ["fetch", "--quiet", UPSTREAM_REMOTE, "--no-tags", `+refs/tags/${tag}:refs/upstream-tags/${tag}`]);
	if (!fetch.ok) {
		// Fall back to a full tag fetch.
		tryRun("git", ["fetch", "--quiet", "--tags", UPSTREAM_REMOTE]);
	}
	const peeled = tryRun("git", ["rev-parse", `refs/upstream-tags/${tag}^{commit}`]);
	if (peeled.ok && peeled.stdout) {
		return peeled.stdout;
	}
	return run("git", ["rev-parse", `${tag}^{commit}`]);
}

function currentPinTag() {
	try {
		const parsed = JSON.parse(readFileSync(PIN_PATH, "utf8"));
		return typeof parsed.tag === "string" ? parsed.tag : "";
	} catch {
		return "";
	}
}

function emit(outputs) {
	const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
	process.stdout.write(`${lines.join("\n")}\n`);
	const file = process.env.GITHUB_OUTPUT;
	if (file) {
		appendFileSync(file, `${lines.join("\n")}\n`);
	}
}

function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--help")) {
		process.stdout.write("Usage: node scripts/check-upstream-release.mjs [--force]\n");
		return 0;
	}
	const force = argv.includes("--force");
	const currentTag = currentPinTag();

	const tag = latestUpstreamReleaseTag();
	log(`latest upstream release: ${tag}`);
	const sha = resolveTagSha(tag);
	log(`resolved ${tag} -> ${sha}`);

	if (force) {
		log("--force set; proceeding regardless of merge state");
		emit({ proceed: "true", tag, sha, current_tag: currentTag });
		return 0;
	}

	const ancestor = tryRun("git", ["merge-base", "--is-ancestor", sha, "HEAD"]);
	const alreadyMerged = ancestor.ok;
	log(alreadyMerged ? `${tag} already merged into HEAD` : `${tag} not yet merged into HEAD`);
	emit({ proceed: alreadyMerged ? "false" : "true", tag, sha, current_tag: currentTag });
	return 0;
}

try {
	process.exitCode = main();
} catch (error) {
	log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
	// On detection failure, do not proceed (avoid releasing on bad state).
	const file = process.env.GITHUB_OUTPUT;
	if (file) {
		appendFileSync(file, "proceed=false\n");
	}
	process.stdout.write("proceed=false\n");
	process.exitCode = 1;
}
